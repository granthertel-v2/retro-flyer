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
  Matrix4,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three'
import { PRESETS } from '@retro-flyer/control'
import { buildAircraft } from './aircraft.js'
import { GearModel } from './gear.js'
import { Afterburner } from './afterburner.js'
import { CAMERA_MODES, ChaseCamera, type CameraMode } from './camera/chase.js'
import { FovController } from './camera/fov.js'
import { InputReader } from './input.js'
import { Simulation } from './loop.js'
import { Overlay, speedCue } from './overlay.js'
import { Hud, type SteerCue } from './hud/hud.js'
import { bearingTo } from './hud/symbology.js'
import { HelpCard } from './help.js'
import { Clouds, SUN_DIRECTION, buildSun, positionSun } from './sky.js'
import { MAP_EXTENT, authoredMap } from './terrain/authored.js'
import { AuthoredGroundSource } from './terrain/groundSource.js'
import { SPAWN, runwayStart } from './spawn.js'
import { buildCourse } from './course.js'
import { buildGates } from './terrain/gates.js'
import { captureSituation, parseSituation, applySlew, speedOf } from './situation.js'
import { fpsToKt, mToFt, referenceSpeed } from '@retro-flyer/physics'
import { buildCity, buildRunways } from './terrain/city.js'
import { TerrainMesh } from './terrain/mesh.js'
import { Scatter } from './terrain/scatter.js'

/**
 * Field elevation for the speed cue, ft.
 *
 * The nearest airfield's, not the terrain directly underneath: on an approach across
 * the bay the ground below is at sea level or under it, and a rotation speed
 * computed there would be for the wrong altitude. The field you are going to is the
 * one whose air you will be landing in.
 */
function nearestFieldElevationFt(x: number, z: number): number {
  let best = authoredMap.airfields[0]
  let bestDistance = Infinity

  for (const field of authoredMap.airfields) {
    const d = Math.hypot(field.x - x, field.z - z)
    if (d < bestDistance) {
      bestDistance = d
      best = field
    }
  }

  return best ? mToFt(best.elevation) : 0
}

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
  // Parented to the aeroplane, so it inherits attitude and needs no frame work.
  const burner = new Afterburner()
  aircraft.add(burner.object)

  // Likewise the gear, which is placed from the flight model's own strut geometry.
  const gearModel = new GearModel()
  aircraft.add(gearModel.object)

  scene.add(aircraft)

  // §8.2 says the renderer asks the terrain for height. The physics now asks too,
  // and in different units — this adapter is the whole cost of keeping them apart.
  const groundSource = new AuthoredGroundSource(authoredMap)

  const simulation = new Simulation(SPAWN, undefined, groundSource)
  const input = new InputReader()
  input.setThrottle(simulation.trimThrottle)

  const course = buildCourse(authoredMap.airfields)
  scene.add(buildGates())

  let slewing = false
  let fieldIndex = 0

  const SAVE_KEY = 'retro-flyer.situation'

  const chase = new ChaseCamera()
  const fov = new FovController()
  const overlay = new Overlay()
  const hud = new Hud()
  const help = new HelpCard()

  // Rebuilt every frame rather than allocated every frame. `Matrix4.elements` is the
  // column-major array `projectDirection` wants, so no conversion happens anywhere.
  const viewProj = new Matrix4()

  let mode: CameraMode = 'chase'
  let presetIndex = 0
  // Down for a runway start, up for an airborne one. Starting the Day 2 spawn with
  // the wheels hanging out is not a small thing to get wrong: it is the first thing
  // anyone sees, and it says the aircraft has just taken off when it has not.
  let gearDown = SPAWN.onGround === true
  let parkingBrake = false
  let wasSlewing = false
  let saveNote = ''
  let saveNoteUntil = 0
  let courseProgress = course.update(
    { x: SPAWN.x, z: SPAWN.z, altFt: SPAWN.alt, onGround: false, speedFps: SPAWN.vt },
    0,
  )

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
      course.reset()
      input.setThrottle(simulation.trimThrottle)
      chase.reset()
    }
    if (commands.resetCourse) course.reset()
    if (commands.toggleParkingBrake) parkingBrake = !parkingBrake
    if (commands.toggleHud) hud.visible = !hud.visible
    if (commands.toggleOverlay) overlay.visible = !overlay.visible
    if (commands.toggleHelp) help.toggle()

    // --- Day 3 -----------------------------------------------------------
    if (commands.toggleGear) gearDown = !gearDown
    if (commands.toggleSlew) slewing = !slewing

    if (commands.nextField) {
      parkingBrake = false
      // Cycle the airfields, starting on the runway at each. This is how a takeoff
      // gets flown without first flying to the field.
      fieldIndex = (fieldIndex + 1) % authoredMap.airfields.length
      simulation.reset(runwayStart(authoredMap.airfields[fieldIndex]!))
      course.reset()
      gearDown = true
      input.setThrottle(0)
      chase.reset()
      slewing = false
    }

    if (commands.saveSituation) {
      try {
        localStorage.setItem(
          SAVE_KEY,
          JSON.stringify(
            captureSituation(simulation.capture(), { ...simulation.layer.toggles }, presetIndex),
          ),
        )
        saveNote = 'SAVED'
      } catch {
        // A private window, or storage disabled. Losing a save is not worth a crash.
        saveNote = 'SAVE FAILED'
      }
      saveNoteUntil = performance.now() + 2000
    }

    if (commands.loadSituation) {
      let stored: string | null = null
      try {
        stored = localStorage.getItem(SAVE_KEY)
      } catch {
        stored = null
      }
      const situation = parseSituation(stored)

      if (situation) {
        simulation.restore(situation.sim)
        gearDown = situation.sim.gear.down
        Object.assign(simulation.layer.toggles, situation.toggles)
        presetIndex = Math.min(PRESETS.length - 1, Math.max(0, situation.preset))
        simulation.layer.preset = PRESETS[presetIndex]!
        input.setThrottle(situation.sim.controls.throttle)
        course.reset()
        chase.reset()
        slewing = false
        saveNote = 'RESTORED'
      } else {
        saveNote = 'NO SAVE'
      }
      saveNoteUntil = performance.now() + 2000
    }

    // Brakes and steering reach the gear directly. A brake is not a control surface,
    // so it does not belong on the §8.1 seam; steering reuses the conditioned rudder
    // command so the nosewheel gets the same smoothing the pedals do.
    simulation.gearInput = {
      // A held key is a poor way to park an aeroplane that taxis on its own at idle,
      // which this one does — 1,041 lb of idle thrust against 410 lb of rolling
      // resistance. The parking brake is the fix; the held key stays for the rollout.
      brake: Math.max(input.brakes(), parkingBrake ? 1 : 0),
      steer: simulation.steerCommand,
      down: gearDown,
    }

    if (slewing) {
      // Slew is a teleport, so the physics does not run. Feeding it dt would have
      // the aircraft accelerating under gravity while the pilot repositions it.
      simulation.setState(applySlew(simulation.snapshot(), input.slew(), dt))
      simulation.paused = true
    } else if (simulation.paused && wasSlewing) {
      simulation.paused = false
    }
    wasSlewing = slewing
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

    courseProgress = course.update(
      {
        x: state.position[0],
        z: state.position[2],
        altFt: state.altFt,
        onGround: simulation.onGround,
        speedFps: speedOf(simulation.snapshot()),
      },
      simulation.paused ? 0 : dt,
    )

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

    burner.update(state.power, dt)
    gearModel.update(gearDown, simulation.gear.compression)

    // In the cockpit the aircraft is the thing you are inside of.
    aircraft.visible = mode !== 'cockpit'

    const referenceKt = fpsToKt(
      // Derived from the aero tables at the nearest field's elevation, so it follows
      // weight and altitude rather than being a constant that goes quietly wrong.
      // See `speeds.ts`.
      referenceSpeed(nearestFieldElevationFt(state.position[0], state.position[2])),
    )

    overlay.update(
      state,
      simulation.layer,
      simulation.nz,
      mode,
      simulation.paused,
      simulation.clock.ticks,
      input.axes(0).throttle,
      {
        onGround: simulation.onGround,
        gearDown,
        brakes: input.brakes() > 0,
        parkingBrake,
        referenceKt,
        bottomed: simulation.gear.bottomed,
        slewing,
        course: courseProgress,
        waypoints: course.waypoints,
        note: performance.now() < saveNoteUntil ? saveNote : '',
      },
    )
    renderer.render(scene, camera)

    // The HUD is drawn from the same matrix the terrain went through, which is the
    // whole reason the flight path marker lands on real ground rather than near it.
    // It has to be read after `chase.update` and the FOV change, both of which move
    // the camera this frame.
    camera.updateMatrixWorld()
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

    const nextGate = course.waypoints[courseProgress.index]
    const steer: SteerCue | null =
      nextGate && courseProgress.status !== 'complete'
        ? {
            name: nextGate.name,
            bearingDeg: bearingTo(
              { x: state.position[0], z: state.position[2] },
              { x: nextGate.x, z: nextGate.z },
            ),
            distanceNm: courseProgress.distanceM / 1852,
          }
        : null

    const telemetry = simulation.layer.lastTelemetry()
    const warnings: string[] = []
    if (telemetry?.aoaLimiting) warnings.push('AOA LIMIT')
    if (telemetry?.gLimiting) warnings.push('G LIMIT')
    if (simulation.gear.bottomed) warnings.push('GEAR BOTTOMED')
    if (slewing) warnings.push('SLEW')
    else if (simulation.paused) warnings.push('PAUSED')

    hud.draw({
      state,
      viewProj: viewProj.elements,
      nz: simulation.nz,
      throttle: input.axes(0).throttle,
      onGround: simulation.onGround,
      gearDown,
      parkingBrake,
      // Orbit swings the camera around the aircraft, and a world-referenced ladder
      // seen from a moving external viewpoint is unreadable. See `HudInputs`.
      conformal: mode !== 'orbit',
      cue: speedCue({
        kt: state.kt,
        targetKt: referenceKt,
        onGround: simulation.onGround,
        gearDown,
      }),
      steer,
      warnings,
    })
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
      course,
      groundSource,
      step,
      startAt: (name: string) => {
        const i = authoredMap.airfields.findIndex((a) => a.name === name)
        if (i < 0) return false
        fieldIndex = i
        simulation.reset(runwayStart(authoredMap.airfields[i]!))
        course.reset()
        gearDown = true
        input.setThrottle(0)
        chase.reset()
        return true
      },
      setCamera: (next: CameraMode) => {
        mode = next
        chase.reset()
      },
    },
  })
}

main()
