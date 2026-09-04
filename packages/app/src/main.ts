/**
 * Bootstrap: scene, loop, cameras, input.
 *
 * Day 2 spawns airborne and trimmed (§9 — ground reaction is Day 3, so "take off
 * from altitude" means exactly that). The spawn point is off the coast north-west of
 * the ridge, pointed at it, because the ridge is the thing worth looking at and a
 * flight sim that starts you facing empty ground makes a poor first impression.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three'
import { PRESETS } from '@retro-flyer/control'
import { buildAircraft } from './aircraft.js'
import { CAMERA_MODES, ChaseCamera, type CameraMode } from './camera/chase.js'
import { FovController } from './camera/fov.js'
import { InputReader } from './input.js'
import { Simulation } from './loop.js'
import { Overlay } from './overlay.js'
import { Clouds, SUN_DIRECTION, buildSun, positionSun } from './sky.js'
import { MAP_EXTENT, authoredMap } from './terrain/authored.js'
import { SPAWN } from './spawn.js'
import { buildCity, buildRunways } from './terrain/city.js'
import { TerrainMesh } from './terrain/mesh.js'
import { Scatter } from './terrain/scatter.js'

/** How far you can see, metres. The outer LOD ring goes further; fog hides its edge. */
const VIEW_DISTANCE = 34_000

const SKY = 0x86b0d6
const HAZE = 0xb3c8d6

function main(): void {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block'
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#000'
  document.body.append(canvas)

  // Logarithmic depth. The view spans two metres to forty kilometres, and a linear
  // depth buffer over that range spends almost all its precision in the first few
  // hundred metres — leaving the shoreline, where terrain meets the sea plane at
  // exactly zero, to shimmer.
  const renderer = new WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

  const scene = new Scene()
  scene.background = new Color(SKY)
  // Linear fog rather than exponential: it has a hard far edge that can be placed
  // exactly at the outer LOD ring, so the ring boundary is never visible.
  //
  // The near distance started at 0.28 of the view distance and that was far too
  // close — from 14,000 ft the coastline, the city and the ridge all sat inside the
  // haze and the map might as well not have been designed. Haze should hide the far
  // edge of the world, not the world.
  scene.fog = new Fog(HAZE, VIEW_DISTANCE * 0.55, VIEW_DISTANCE)

  const camera = new PerspectiveCamera(58, 1, 2, VIEW_DISTANCE * 1.3)

  // Flat shading needs a real directional source or every face reads the same. The
  // light direction and the visible sun disc share `SUN_DIRECTION`, so the shadows
  // point away from the thing casting them.
  const sunLight = new DirectionalLight(0xfff2df, 2.15)
  sunLight.position.copy(SUN_DIRECTION)
  scene.add(sunLight, new AmbientLight(0x93a9c4, 1.25))

  // The sea. Terrain below zero is seabed; this is the surface over it.
  const sea = new Mesh(
    new PlaneGeometry(MAP_EXTENT * 6, MAP_EXTENT * 6),
    new MeshBasicMaterial({ color: 0x1b4a68 }),
  )
  sea.rotation.x = -Math.PI / 2
  sea.position.y = 0
  sea.renderOrder = -10
  scene.add(sea)

  const terrain = new TerrainMesh(authoredMap)
  terrain.buildAll(SPAWN.x, SPAWN.z)
  scene.add(terrain.object)
  scene.add(buildCity(authoredMap))
  scene.add(buildRunways(authoredMap))

  const scatter = new Scatter(authoredMap)
  scene.add(scatter.mesh)

  const sun = buildSun()
  scene.add(sun)

  const clouds = new Clouds()
  scene.add(clouds.mesh)

  const aircraft = buildAircraft()
  scene.add(aircraft)

  const simulation = new Simulation(SPAWN)
  const input = new InputReader()
  input.setThrottle(simulation.trimThrottle)

  const chase = new ChaseCamera()
  const fov = new FovController()
  const overlay = new Overlay()

  let mode: CameraMode = 'chase'
  let presetIndex = 0

  const resize = (): void => {
    const width = window.innerWidth
    const height = window.innerHeight
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', resize)
  resize()

  let last = performance.now()

  /**
   * One frame, given an explicit time step.
   *
   * Split out from the animation callback so it can be driven directly. A hidden
   * tab gets no `requestAnimationFrame` callbacks at all — Chrome pauses them
   * outright — which makes the renderer impossible to exercise from browser
   * automation. Being able to step it by hand also makes a captured flight
   * deterministic rather than dependent on whatever frame rate the recorder
   * happened to get.
   */
  const step = (dt: number): void => {
    const commands = input.commands()

    if (commands.cycleCamera) {
      mode = CAMERA_MODES[(CAMERA_MODES.indexOf(mode) + 1) % CAMERA_MODES.length] as CameraMode
      chase.reset()
    }
    if (commands.togglePause) simulation.paused = !simulation.paused
    if (commands.reset) {
      simulation.reset()
      input.setThrottle(simulation.trimThrottle)
      chase.reset()
    }
    if (commands.cyclePreset) {
      presetIndex = (presetIndex + 1) % PRESETS.length
      simulation.layer.preset = PRESETS[presetIndex]!
    }
    if (commands.allAssistsOn) simulation.layer.setAll(true)
    if (commands.allAssistsOff) simulation.layer.setAll(false)
    if (commands.toggleAssist !== null) {
      const keys = Object.keys(simulation.layer.toggles) as (keyof typeof simulation.layer.toggles)[]
      const key = keys[commands.toggleAssist]
      if (key) simulation.layer.toggles[key] = !simulation.layer.toggles[key]
    }

    simulation.advance(dt, () => input.axes(dt))

    const state = simulation.render()

    aircraft.position.set(state.position[0], state.position[1], state.position[2])
    aircraft.quaternion.set(
      state.quaternion[0],
      state.quaternion[1],
      state.quaternion[2],
      state.quaternion[3],
    )

    terrain.update(state.position[0], state.position[2])
    scatter.update(state.position[0], state.position[2])
    clouds.update(state.position[0], state.position[2])
    // A hair below sea level, so a terrain triangle that touches exactly zero at the
    // waterline is not co-planar with it.
    sea.position.set(state.position[0], -0.4, state.position[2])

    chase.update(camera, state, mode, simulation.nz, simulation.ax, simulation.sustain, dt)
    positionSun(sun, camera.position)
    camera.fov = fov.update(state.kt, simulation.ax, simulation.sustain, dt)
    camera.updateProjectionMatrix()

    // In the cockpit the aircraft is the thing you are inside of.
    aircraft.visible = mode !== 'cockpit'

    overlay.update(
      state,
      simulation.layer,
      simulation.nz,
      mode,
      simulation.paused,
      simulation.clock.ticks,
      input.axes(0).throttle,
    )
    renderer.render(scene, camera)
  }

  const frame = (now: number): void => {
    requestAnimationFrame(frame)

    // Cap the frame delta. A backgrounded tab returns with a delta of minutes, and
    // `FixedStepClock` would then try to run tens of thousands of physics ticks in
    // one frame — the page hangs, and it looks like a crash.
    const dt = Math.min((now - last) / 1000, 0.25)
    last = now

    step(dt)
  }

  requestAnimationFrame(frame)

  // Debug handle. Not a feature — it is how the renderer gets inspected from the
  // console and from the browser automation that captures the Day 2 screenshots.
  Object.assign(window as unknown as Record<string, unknown>, {
    __rf: {
      scene,
      camera,
      renderer,
      simulation,
      terrain,
      input,
      map: authoredMap,
      step,
      setCamera: (next: CameraMode) => {
        mode = next
        chase.reset()
      },
    },
  })
}

main()
