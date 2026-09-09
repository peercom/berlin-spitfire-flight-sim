use std::f64::consts::PI;
use wasm_bindgen::prelude::*;

const EARTH_RADIUS_M: f64 = 6_371_008.8;
const GRAVITY: f64 = 9.80665;
const BERLIN_LAT: f64 = 52.516275;
const BERLIN_LON: f64 = 13.377704;
const MASS_KG: f64 = 3_350.0;
const WING_AREA_M2: f64 = 22.48;

#[wasm_bindgen]
pub struct FlightSim {
    latitude_deg: f64,
    longitude_deg: f64,
    altitude_m: f64,
    heading_rad: f64,
    pitch_rad: f64,
    roll_rad: f64,
    roll_rate: f64,
    pitch_rate: f64,
    airspeed_mps: f64,
    vertical_speed_mps: f64,
    throttle: f64,
    commanded_throttle: f64,
    ground_elevation_m: f64,
    distance_from_berlin_km: f64,
    crashed: bool,
}

#[wasm_bindgen]
impl FlightSim {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FlightSim {
        FlightSim {
            latitude_deg: 52.5208,
            longitude_deg: 13.4095,
            altitude_m: 1_200.0,
            heading_rad: 265.0_f64.to_radians(),
            pitch_rad: 1.2_f64.to_radians(),
            roll_rad: -5.0_f64.to_radians(),
            roll_rate: 0.0,
            pitch_rate: 0.0,
            airspeed_mps: 122.0,
            vertical_speed_mps: 0.0,
            throttle: 0.65,
            commanded_throttle: 0.65,
            ground_elevation_m: 40.0,
            distance_from_berlin_km: 0.0,
            crashed: false,
        }
    }

    pub fn reset(&mut self) { *self = FlightSim::new(); }

    pub fn update(&mut self, dt_seconds: f64, roll_input: f64, pitch_input: f64, throttle: f64) {
        if self.crashed { return; }
        self.commanded_throttle = throttle.clamp(0.0, 1.0);
        let steps = (dt_seconds.clamp(0.0, 0.25) / 0.016).ceil().max(1.0) as usize;
        let dt = dt_seconds.clamp(0.0, 0.25) / steps as f64;
        for _ in 0..steps { self.integrate(dt, roll_input.clamp(-1.0, 1.0), pitch_input.clamp(-1.0, 1.0)); }
    }

    fn integrate(&mut self, dt: f64, pilot_roll: f64, pilot_pitch: f64) {
        self.throttle += (self.commanded_throttle - self.throttle) * (1.0 - (-dt / 0.75).exp());

        let authority = (self.airspeed_mps / 95.0).powi(2).clamp(0.28, 2.2);
        self.distance_from_berlin_km = haversine_km(self.latitude_deg, self.longitude_deg, BERLIN_LAT, BERLIN_LON);
        let boundary_blend = ((self.distance_from_berlin_km - 94.0) / 6.0).clamp(0.0, 1.0);
        let home_bearing = bearing_rad(self.latitude_deg, self.longitude_deg, BERLIN_LAT, BERLIN_LON);
        let home_error = wrap_pi(home_bearing - self.heading_rad);
        let boundary_roll = (home_error * 1.4).clamp(-1.0, 1.0);
        let roll_command = pilot_roll * (1.0 - boundary_blend) + boundary_roll * boundary_blend;

        let roll_accel = 1.65 * authority * roll_command - 2.25 * self.roll_rate - 0.38 * self.roll_rad;
        self.roll_rate = (self.roll_rate + roll_accel * dt).clamp(-1.7, 1.7);
        self.roll_rad = (self.roll_rad + self.roll_rate * dt).clamp(-1.38, 1.38);

        let pitch_accel = 0.82 * authority * pilot_pitch - 2.1 * self.pitch_rate - 0.34 * self.pitch_rad;
        self.pitch_rate = (self.pitch_rate + pitch_accel * dt).clamp(-0.72, 0.72);
        self.pitch_rad = (self.pitch_rad + self.pitch_rate * dt).clamp(-0.52, 0.58);

        let flight_path = (self.vertical_speed_mps / self.airspeed_mps.max(35.0)).clamp(-0.75, 0.75).asin();
        let alpha = (self.pitch_rad - flight_path).clamp(-0.30, 0.42);
        let raw_cl = 0.29 + 4.75 * alpha + 0.42 * pilot_pitch;
        let stall = ((alpha.abs() - 0.26) / 0.16).clamp(0.0, 1.0);
        let cl = raw_cl.clamp(-1.15, 1.58) * (1.0 - 0.55 * stall);
        let density = 1.225 * (-self.altitude_m.max(0.0) / 8_500.0).exp();
        let dynamic_pressure = 0.5 * density * self.airspeed_mps * self.airspeed_mps;
        let lift = dynamic_pressure * WING_AREA_M2 * cl;
        let cd = 0.024 + 0.052 * cl * cl + 0.035 * stall;
        let drag = dynamic_pressure * WING_AREA_M2 * cd;
        let prop_efficiency = (1.0 - self.airspeed_mps / 360.0).clamp(0.34, 1.0);
        let thrust = 15_200.0 * self.throttle * prop_efficiency;

        let vertical_accel = lift * self.roll_rad.cos() / MASS_KG
            + thrust * self.pitch_rad.sin() / MASS_KG - GRAVITY;
        self.vertical_speed_mps = (self.vertical_speed_mps + vertical_accel * dt).clamp(-115.0, 90.0);
        let forward_accel = (thrust - drag) / MASS_KG - GRAVITY * flight_path.sin();
        self.airspeed_mps = (self.airspeed_mps + forward_accel * dt).clamp(34.0, 205.0);

        let horizontal_speed = (self.airspeed_mps.powi(2) - self.vertical_speed_mps.powi(2)).max(900.0).sqrt();
        let turn_rate = GRAVITY * self.roll_rad.tan() / horizontal_speed;
        self.heading_rad = wrap_tau(self.heading_rad + turn_rate * dt);
        self.altitude_m += self.vertical_speed_mps * dt;

        let north_mps = horizontal_speed * self.heading_rad.cos();
        let east_mps = horizontal_speed * self.heading_rad.sin();
        self.latitude_deg += (north_mps * dt / EARTH_RADIUS_M).to_degrees();
        self.longitude_deg += (east_mps * dt / (EARTH_RADIUS_M * self.latitude_deg.to_radians().cos())).to_degrees();

        if self.altitude_m <= self.ground_elevation_m + 2.5 {
            self.altitude_m = self.ground_elevation_m + 2.5;
            self.crashed = true;
        }
    }

    pub fn set_ground_elevation(&mut self, metres: f64) { self.ground_elevation_m = metres; }
    pub fn latitude(&self) -> f64 { self.latitude_deg }
    pub fn longitude(&self) -> f64 { self.longitude_deg }
    pub fn altitude(&self) -> f64 { self.altitude_m }
    pub fn heading(&self) -> f64 { self.heading_rad }
    pub fn pitch(&self) -> f64 { self.pitch_rad }
    pub fn roll(&self) -> f64 { self.roll_rad }
    pub fn airspeed(&self) -> f64 { self.airspeed_mps }
    pub fn vertical_speed(&self) -> f64 { self.vertical_speed_mps }
    pub fn throttle(&self) -> f64 { self.throttle }
    pub fn distance_from_berlin(&self) -> f64 { self.distance_from_berlin_km }
    pub fn is_crashed(&self) -> bool { self.crashed }
}

fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().asin() / 1_000.0
}

fn bearing_rad(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let p1 = lat1.to_radians();
    let p2 = lat2.to_radians();
    let dl = (lon2 - lon1).to_radians();
    wrap_tau((dl.sin() * p2.cos()).atan2(p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos()))
}

fn wrap_pi(value: f64) -> f64 { (value + PI).rem_euclid(2.0 * PI) - PI }
fn wrap_tau(value: f64) -> f64 { value.rem_euclid(2.0 * PI) }

#[cfg(test)]
mod tests {
    use super::*;

    fn run(sim: &mut FlightSim, seconds: f64, roll: f64, pitch: f64, throttle: f64) {
        for _ in 0..(seconds * 60.0) as usize { sim.update(1.0 / 60.0, roll, pitch, throttle); }
    }

    #[test]
    fn throttle_accelerates_the_aircraft() {
        let mut sim = FlightSim::new();
        let initial = sim.airspeed();
        run(&mut sim, 8.0, 0.0, 0.0, 1.0);
        assert!(sim.airspeed() > initial + 2.0);
    }

    #[test]
    fn rolling_causes_a_banked_turn() {
        let mut sim = FlightSim::new();
        let initial_heading = sim.heading();
        run(&mut sim, 2.0, 0.8, 0.0, 0.7);
        run(&mut sim, 5.0, 0.0, 0.0, 0.7);
        assert!(sim.roll().abs() > 0.03);
        assert!(wrap_pi(sim.heading() - initial_heading).abs() > 0.02);
    }

    #[test]
    fn pitch_up_eventually_climbs() {
        let mut sim = FlightSim::new();
        let initial_altitude = sim.altitude();
        run(&mut sim, 7.0, 0.0, 0.45, 0.8);
        assert!(sim.altitude() > initial_altitude + 10.0);
        assert!(sim.vertical_speed() > 0.0);
    }

    #[test]
    fn berlin_distance_is_finite_and_local() {
        let mut sim = FlightSim::new();
        sim.update(1.0 / 60.0, 0.0, 0.0, 0.65);
        assert!(sim.distance_from_berlin().is_finite());
        assert!(sim.distance_from_berlin() < 5.0);
    }

    #[test]
    fn sector_autopilot_contains_sustained_outward_flight() {
        let mut sim = FlightSim::new();
        sim.altitude_m = 5_000.0;
        sim.ground_elevation_m = -1_000.0;
        let mut furthest: f64 = 0.0;
        for _ in 0..(22 * 60 * 60) {
            sim.update(1.0 / 60.0, 0.0, 0.025, 1.0);
            furthest = furthest.max(sim.distance_from_berlin());
        }
        assert!(furthest <= 100.0, "sector overshoot reached {furthest:.2} km");
    }
}
