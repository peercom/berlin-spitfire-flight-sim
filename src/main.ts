import "cesium/Build/Cesium/Widgets/widgets.css";
import "./style.css";
import initWasm, { FlightSim } from "./wasm/flight_core";
import {
  ArcGISTiledElevationTerrainProvider,
  ArcGisMapServerImageryProvider,
  Axis,
  Cartesian2,
  Cartesian3,
  Color,
  Cesium3DTileset,
  createGooglePhotorealistic3DTileset,
  createOsmBuildingsAsync,
  EllipseGraphics,
  Ellipsoid,
  HeadingPitchRoll,
  Ion,
  JulianDate,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  Model,
  ModelNode,
  ShadowMode,
  Terrain,
  Transforms,
  Viewer,
  WebMapServiceImageryProvider,
} from "cesium";
import { BuildingStreamer } from "./building-streamer";

const BERLIN = { lat: 52.516275, lon: 13.377704 };
const ELEVATION_URL = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";
const SATELLITE_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const AERIAL_WMS = "https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms";
const BERLIN_2025_MESH = "https://www.businesslocationcenter.de/berlin3d-downloadportal/datasource-data/HOSTING-Berlin-DLPortal/Mesh_2025/tileset.json";
const QUERY = new URLSearchParams(window.location.search);
const CAPTURE_MODE = QUERY.has("capture");
const BANK_DEMO = CAPTURE_MODE ? QUERY.get("bank") : null;
const PITCH_DEMO = CAPTURE_MODE ? QUERY.get("pitch") : null;

const boot = element<HTMLDivElement>("boot");
const bootStatus = element<HTMLParagraphElement>("boot-status");
const startButton = element<HTMLButtonElement>("start");
const hud = element<HTMLElement>("hud");
const controls = element<HTMLElement>("controls");
const crosshair = element<HTMLDivElement>("crosshair");
const warning = element<HTMLDivElement>("warning");
const dataStatus = element<HTMLDivElement>("data-status");
const throttleSlider = element<HTMLInputElement>("throttle");

let viewer: Viewer;
let sim: FlightSim;
let running = false;
let flightStartedAt = Number.POSITIVE_INFINITY;
let groundElevation = 36;
let lastTerrainSample = 0;
let buildingStreamer: BuildingStreamer | undefined;
let aircraftModel: Model;
let engineAudio: EngineAudio | undefined;

type AnimatedNode = { node: ModelNode; rest: Matrix4 };
type EngineAudio = {
  context: AudioContext;
  combustion: OscillatorNode;
  propeller: OscillatorNode;
  engineGain: GainNode;
  windGain: GainNode;
};
let aileronControl: AnimatedNode | undefined;
let elevatorControl: AnimatedNode | undefined;
let propellerControl: AnimatedNode | undefined;

const input = { left: false, right: false, up: false, down: false, throttle: 0.65 };

async function bootSimulator(): Promise<void> {
  await initWasm();
  sim = new FlightSim();
  bootStatus.textContent = "Connecting elevation and official aerial-imagery streams…";

  const ionToken = import.meta.env.VITE_CESIUM_ION_ACCESS_TOKEN?.trim();
  if (ionToken) Ion.defaultAccessToken = ionToken;

  let terrainProvider;
  try {
    terrainProvider = ionToken
      ? Terrain.fromWorldTerrain({ requestVertexNormals: true, requestWaterMask: true })
      : await ArcGISTiledElevationTerrainProvider.fromUrl(ELEVATION_URL);
  } catch {
    terrainProvider = undefined;
  }

  viewer = new Viewer("cesium", {
    baseLayer: false,
    terrain: terrainProvider instanceof Terrain ? terrainProvider : undefined,
    terrainProvider: terrainProvider instanceof Terrain ? undefined : terrainProvider,
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
    requestRenderMode: false,
    shouldAnimate: true,
    contextOptions: {
      webgl: { preserveDrawingBuffer: CAPTURE_MODE },
    },
  });

  configureScene(viewer);
  await addAerialImagery(viewer);
  addBoundary(viewer);

  const dataMode = await addBuildings(viewer, ionToken);
  dataStatus.textContent = dataMode;

  aircraftModel = await Model.fromGltfAsync({
    url: "/models/spitfire_mkix.glb",
    modelMatrix: aircraftMatrix(positionFromSim()),
    minimumPixelSize: 78,
    maximumScale: 4.5,
    shadows: ShadowMode.ENABLED,
    upAxis: Axis.Y,
    forwardAxis: Axis.X,
  });
  aircraftModel.id = "spitfire";
  viewer.scene.primitives.add(aircraftModel);
  if (!aircraftModel.ready) {
    await new Promise<void>((resolve) => aircraftModel.readyEvent.addEventListener(() => resolve()));
  }
  aircraftModel.lightColor = new Cartesian3(1.35, 1.31, 1.24);
  aircraftModel.imageBasedLighting.imageBasedLightingFactor = new Cartesian2(1.35, 1.12);
  aircraftModel.environmentMapManager.groundColor = Color.fromCssColorString("#52624d");
  aileronControl = animatedNode("Aileron.WGT");
  elevatorControl = animatedNode("elevator.WGT");
  propellerControl = animatedNode("Cone.WGT");
  if (!aileronControl || !elevatorControl || !propellerControl) {
    throw new Error("The Spitfire control rig is incomplete in the web model.");
  }

  bootStatus.textContent = "Spitfire ready over central Berlin";
  startButton.disabled = false;
  startButton.addEventListener("click", () => {
    engineAudio = startEngineAudio();
    running = true;
    flightStartedAt = performance.now();
    boot.classList.add("hidden");
    hud.classList.remove("hidden");
    controls.classList.remove("hidden");
    crosshair.classList.remove("hidden");
    dataStatus.classList.remove("hidden");
  }, { once: true });

  setupControls();
  startLoop();
}

function configureScene(current: Viewer): void {
  current.scene.globe.enableLighting = true;
  current.scene.globe.dynamicAtmosphereLighting = true;
  current.scene.globe.showGroundAtmosphere = true;
  current.scene.globe.depthTestAgainstTerrain = true;
  current.scene.globe.maximumScreenSpaceError = 2.1;
  current.scene.fog.enabled = true;
  current.scene.fog.density = 0.00012;
  if (current.scene.skyAtmosphere) current.scene.skyAtmosphere.atmosphereLightIntensity = 9.0;
  current.scene.postProcessStages.fxaa.enabled = true;
  current.scene.msaaSamples = 4;
  current.scene.highDynamicRange = true;
  current.clock.currentTime = JulianDate.fromIso8601("2026-06-21T16:15:00Z");
  current.clock.shouldAnimate = false;
  current.resolutionScale = Math.min(window.devicePixelRatio, 1.15);
  if (CAPTURE_MODE) {
    const frame = document.createElement("img");
    frame.id = "rendered-frame";
    frame.alt = "Latest simulator render";
    frame.hidden = true;
    document.body.append(frame);
    let lastCapture = 0;
    current.scene.postRender.addEventListener(() => {
      const now = performance.now();
      if (now - lastCapture > 1200) {
        lastCapture = now;
        frame.src = current.canvas.toDataURL("image/jpeg", 0.86);
      }
    });
  }
}

async function addAerialImagery(current: Viewer): Promise<void> {
  try {
    const satellite = await ArcGisMapServerImageryProvider.fromUrl(SATELLITE_URL, {
      enablePickFeatures: false,
    });
    const base = current.imageryLayers.addImageryProvider(satellite);
    base.brightness = 0.92;
    base.contrast = 1.03;
    base.saturation = 0.92;
  } catch {
    // The high-resolution regional layer below can still run independently.
  }
  const imagery = new WebMapServiceImageryProvider({
    url: AERIAL_WMS,
    layers: "bebb_dop20c",
    parameters: {
      service: "WMS",
      version: "1.3.0",
      request: "GetMap",
      format: "image/png",
      transparent: true,
    },
    credit: "GeoBasis-DE / LGB · DOP20c · dl-de/by-2-0",
    enablePickFeatures: false,
  });
  const layer = current.imageryLayers.addImageryProvider(imagery);
  layer.brightness = 0.93;
  layer.contrast = 1.06;
  layer.saturation = 0.9;
  layer.gamma = 1.02;
}

async function addBuildings(current: Viewer, token?: string): Promise<string> {
  if (token) {
    try {
      if (import.meta.env.VITE_USE_GOOGLE_PHOTOREALISTIC_TILES === "true") {
        const tiles = await createGooglePhotorealistic3DTileset();
        tiles.maximumScreenSpaceError = 8;
        current.scene.primitives.add(tiles);
        current.scene.globe.show = false;
        return "Google photogrammetry · WebAssembly dynamics";
      }
      const buildings = await createOsmBuildingsAsync();
      buildings.maximumScreenSpaceError = 10;
      current.scene.primitives.add(buildings);
      return "Cesium OSM buildings · official 20 cm aerial imagery";
    } catch {
      // The open-data path below remains fully usable if ion content is unavailable.
    }
  }
  try {
    const officialMesh = await Cesium3DTileset.fromUrl(BERLIN_2025_MESH, {
      maximumScreenSpaceError: 7,
      dynamicScreenSpaceError: true,
      cullWithChildrenBounds: true,
      preloadFlightDestinations: true,
    });
    current.scene.primitives.add(officialMesh);
    buildingStreamer = new BuildingStreamer(current, (message) => { dataStatus.textContent = message; });
    return "Official Berlin 2025 photogrammetry · 20 cm aerial imagery";
  } catch {
    // Fall through to live building footprints if the official mesh is offline.
  }
  buildingStreamer = new BuildingStreamer(current, (message) => { dataStatus.textContent = message; });
  return "Open-data mode · loading nearby OSM buildings";
}

function addBoundary(current: Viewer): void {
  current.entities.add({
    id: "berlin-sector",
    position: Cartesian3.fromDegrees(BERLIN.lon, BERLIN.lat, 100),
    ellipse: new EllipseGraphics({
      semiMajorAxis: 100_000,
      semiMinorAxis: 100_000,
      material: Color.TRANSPARENT,
      outline: true,
      outlineColor: Color.fromCssColorString("#e2ba6e").withAlpha(0.32),
      height: 120,
    }),
  });
}

function setupControls(): void {
  const key = (event: KeyboardEvent, down: boolean) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyW", "KeyS", "KeyR"].includes(event.code)) event.preventDefault();
    if (event.code === "ArrowLeft") input.left = down;
    if (event.code === "ArrowRight") input.right = down;
    // Keyboard arrows use flight-stick convention: forward pitches the nose
    // down, while pulling back pitches it up. Touch arrows stay pictorial.
    if (event.code === "ArrowUp") input.down = down;
    if (event.code === "ArrowDown") input.up = down;
    if (down && event.code === "KeyW") setThrottle(input.throttle + 0.05);
    if (down && event.code === "KeyS") setThrottle(input.throttle - 0.05);
    if (down && event.code === "KeyR") { sim.reset(); setThrottle(0.65); }
  };
  window.addEventListener("keydown", (event) => key(event, true), { passive: false });
  window.addEventListener("keyup", (event) => key(event, false), { passive: false });
  throttleSlider.addEventListener("input", () => setThrottle(Number(throttleSlider.value) / 100));

  document.querySelectorAll<HTMLButtonElement>("[data-control]").forEach((button) => {
    const update = (down: boolean) => {
      const control = button.dataset.control;
      if (control === "roll-left") input.left = down;
      if (control === "roll-right") input.right = down;
      if (control === "pitch-up") input.up = down;
      if (control === "pitch-down") input.down = down;
    };
    button.addEventListener("pointerdown", (event) => { button.setPointerCapture(event.pointerId); update(true); });
    button.addEventListener("pointerup", () => update(false));
    button.addEventListener("pointercancel", () => update(false));
  });
}

function startLoop(): void {
  let previous = performance.now();
  let accumulator = 0;
  const fixed = 1 / 120;
  const frame = (now: number) => {
    const elapsed = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    const roll = BANK_DEMO === "left"
      ? -0.72
      : BANK_DEMO === "right"
        ? 0.72
        : Number(input.right) - Number(input.left);
    const pitch = PITCH_DEMO === "climb"
      ? 0.45
      : PITCH_DEMO === "descent"
        ? -0.45
        : Number(input.up) - Number(input.down);
    if (running) {
      accumulator += elapsed;
      while (accumulator >= fixed) {
        sim.update(fixed, roll, pitch, input.throttle);
        accumulator -= fixed;
      }
      if (sim.is_crashed()) { sim.reset(); setThrottle(0.65); }
    }

    const aircraftPosition = positionFromSim();
    aircraftModel.modelMatrix = aircraftMatrix(aircraftPosition);
    animateAircraft(roll, pitch, now);
    updateCamera(aircraftPosition);
    updateHud();
    updateEngineAudio();
    if (now - flightStartedAt > 15_000 && sim.distance_from_berlin() > 24) {
      buildingStreamer?.update(sim.latitude(), sim.longitude());
    }
    sampleGround(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function positionFromSim(): Cartesian3 {
  return Cartesian3.fromDegrees(sim.longitude(), sim.latitude(), sim.altitude(), Ellipsoid.WGS84);
}

function aircraftMatrix(position: Cartesian3): Matrix4 {
  return Transforms.headingPitchRollToFixedFrame(position, new HeadingPitchRoll(
    renderHeading(),
    sim.pitch(),
    sim.roll(),
  ));
}

// FlightSim headings are conventional navigation bearings (0° north,
// clockwise positive). Cesium's HPR frame starts at local east, so subtract
// 90° to make the model's +X nose axis follow the geodetic velocity vector.
function renderHeading(): number {
  return sim.heading() - Math.PI / 2;
}

function animatedNode(name: string): AnimatedNode | undefined {
  const node = aircraftModel.getNode(name);
  return node ? { node, rest: Matrix4.clone(node.matrix) } : undefined;
}

function animateAircraft(rollInput: number, pitchInput: number, now: number): void {
  setNodeRotation(aileronControl, Matrix3.fromRotationZ(CesiumMath.toRadians(13) * rollInput));
  setNodeRotation(elevatorControl, Matrix3.fromRotationX(CesiumMath.toRadians(-11) * pitchInput));
  const propellerRadians = now * (0.075 + input.throttle * 0.19);
  setNodeRotation(propellerControl, Matrix3.fromRotationY(propellerRadians));
}

function setNodeRotation(control: AnimatedNode | undefined, rotation: Matrix3): void {
  if (!control) return;
  const delta = Matrix4.fromRotationTranslation(rotation);
  control.node.matrix = Matrix4.multiply(control.rest, delta, new Matrix4());
}

function updateCamera(position: Cartesian3): void {
  const frame = Transforms.headingPitchRollToFixedFrame(position, new HeadingPitchRoll(renderHeading(), sim.pitch() * 0.25, sim.roll() * 0.32));
  viewer.camera.lookAtTransform(frame, new Cartesian3(-34, 0, 8.5));
}

function updateHud(): void {
  element("speed").textContent = Math.round(sim.airspeed() * 3.6).toString().padStart(3, "0");
  element("altitude").textContent = Math.round(sim.altitude() - groundElevation).toString().padStart(4, "0");
  element("heading").textContent = Math.round(CesiumMath.toDegrees(sim.heading())).toString().padStart(3, "0");
  element("throttle-readout").textContent = Math.round(sim.throttle() * 100).toString();
  element("radius").textContent = sim.distance_from_berlin().toFixed(1);
  warning.classList.toggle("hidden", sim.distance_from_berlin() < 94);
}

function sampleGround(now: number): void {
  if (now - lastTerrainSample < 750 || !viewer.scene.globe.tilesLoaded) return;
  lastTerrainSample = now;
  const cartographic = Ellipsoid.WGS84.cartesianToCartographic(positionFromSim());
  const sampled = viewer.scene.globe.getHeight(cartographic);
  if (sampled !== undefined && Number.isFinite(sampled)) {
    groundElevation = sampled;
    sim.set_ground_elevation(sampled);
  }
}

function setThrottle(value: number): void {
  input.throttle = Math.max(0, Math.min(1, value));
  throttleSlider.value = Math.round(input.throttle * 100).toString();
}

function startEngineAudio(): EngineAudio | undefined {
  try {
    const context = new AudioContext();
    const master = context.createGain();
    master.gain.value = 0.16;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 14;
    compressor.ratio.value = 5;
    master.connect(compressor).connect(context.destination);

    const engineGain = context.createGain();
    engineGain.gain.value = 0.18;
    const engineFilter = context.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 1_100;
    engineFilter.Q.value = 1.5;
    engineGain.connect(engineFilter).connect(master);

    const combustion = context.createOscillator();
    combustion.type = "sawtooth";
    const combustionGain = context.createGain();
    combustionGain.gain.value = 0.46;
    combustion.connect(combustionGain).connect(engineGain);

    const propeller = context.createOscillator();
    propeller.type = "triangle";
    const propellerGain = context.createGain();
    propellerGain.gain.value = 0.24;
    propeller.connect(propellerGain).connect(engineGain);

    const noiseLength = Math.floor(context.sampleRate * 2);
    const noiseBuffer = context.createBuffer(1, noiseLength, context.sampleRate);
    const noise = noiseBuffer.getChannelData(0);
    let brown = 0;
    for (let index = 0; index < noiseLength; index += 1) {
      brown = (brown + (Math.random() * 2 - 1) * 0.055) * 0.985;
      noise[index] = brown;
    }
    const wind = context.createBufferSource();
    wind.buffer = noiseBuffer;
    wind.loop = true;
    const windFilter = context.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 760;
    windFilter.Q.value = 0.55;
    const windGain = context.createGain();
    windGain.gain.value = 0.05;
    wind.connect(windFilter).connect(windGain).connect(master);

    combustion.start();
    propeller.start();
    wind.start();
    void context.resume();
    return { context, combustion, propeller, engineGain, windGain };
  } catch {
    return undefined;
  }
}

function updateEngineAudio(): void {
  if (!engineAudio) return;
  const now = engineAudio.context.currentTime;
  const rpm = 700 + sim.throttle() * 2_350;
  engineAudio.combustion.frequency.setTargetAtTime((rpm / 60) * 3, now, 0.08);
  engineAudio.propeller.frequency.setTargetAtTime((rpm / 60) * 4, now, 0.08);
  engineAudio.engineGain.gain.setTargetAtTime(0.1 + sim.throttle() * 0.24, now, 0.12);
  engineAudio.windGain.gain.setTargetAtTime(Math.min(0.2, sim.airspeed() / 780), now, 0.18);
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

bootSimulator().catch((error) => {
  console.error(error);
  bootStatus.textContent = "Unable to initialise the simulator. See the browser console for details.";
});
