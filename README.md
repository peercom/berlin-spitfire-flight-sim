# Spitfire IX · Berlin 100 km

A browser flight simulator built around the detailed Supermarine Spitfire Mk IX model and a Rust/WebAssembly flight core.

## Play

Install Node.js 22+, pnpm, Rust, and `wasm-pack`, then:

```bash
pnpm install
pnpm build
pnpm dev
```

The development server runs at `http://127.0.0.1:5173/`. After building, you can also double-click `start.command` to serve the production build at `http://127.0.0.1:4173/`.

An internet connection is required while playing because terrain, aerial imagery, the official Berlin city mesh, and rural building data stream from their public providers.

## Controls

- Arrow left/right: roll. The aircraft banks and turns through coordinated lift.
- Arrow up: pitch the nose down.
- Arrow down: pitch the nose up.
- W/S: increase/decrease throttle.
- R: reset over central Berlin.
- Touch devices: use the on-screen directional pad and throttle slider.

The simulator gently takes over near the 100 km limit and banks the aircraft back toward Berlin.

## World data

- June 2025 textured Berlin 3D mesh: Berlin Partner für Wirtschaft und Technologie GmbH / State of Berlin open-data portal.
- 20 cm colour orthophotography: GeoBasis-DE / LGB, dl-de/by-2-0.
- Elevation: Esri WorldElevation3D Terrain3D public service.
- Rural building footprints: OpenStreetMap contributors via Overpass.
- Globe renderer: CesiumJS.

The Berlin mesh covers the capital and BER airport. Beyond its footprint, the simulator continues with elevation, orthophotography, and streamed OpenStreetMap buildings throughout the 100 km sector.

## Aircraft credit

Base Spitfire Mk IX asset by RealWorks3D via Blendkit, Blendkit Royalty Free license; creator attribution requested. The aircraft was rebuilt and enhanced for this simulator with new cockpit detail, pilot, markings, materials, animated flight controls, and web export processing.

### Aircraft asset setup

The `.glb` aircraft binary is intentionally excluded from this public source repository. BlendKit's Royalty Free terms allow the model to be incorporated into software, but prohibit distributing it in an extractable form. Obtain the Spitfire Mk IX asset through BlendKit under your own account and licence, apply the project-specific enhancements, then export it to:

```text
public/models/spitfire_mkix.glb
```

The web animation expects nodes named `Aileron.WGT`, `elevator.WGT`, and `Cone.WGT` for the ailerons, elevator, and propeller.

The application source is published without an additional repository-wide licence. Third-party data, libraries, and aircraft artwork retain their respective terms.

## Browser support

Use a current Chrome, Edge, Safari, or Firefox with WebAssembly and WebGL 2 enabled. A dedicated GPU is recommended for the official photogrammetry layer.
