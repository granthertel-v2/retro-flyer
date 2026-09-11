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
import { InputReader, NO_COMMANDS } from './input.js'
import { Simulation, type SpawnCondition } from './loop.js'
import { Overlay, speedCue } from './overlay.js'
import { Hud, type SteerCue } from './hud/hud.js'
import { bearingTo } from './hud/symbology.js'
import { HelpCard } from './help.js'
import { Minimap } from './minimap.js'
import { Clouds, SUN_DIRECTION, buildSun, positionSun } from './sky.js'
import { authoredMap } from './terrain/authored.js'
import { isRegionId, loadRegion } from './terrain/load.js'
import type { TerrainSource } from './terrain/source.js'
import { TerrainGroundSource } from './terrain/groundSource.js'
import { SPAWN, airborneStart, runwayStart } from './spawn.js'
import type { Airfield } from './terrain/source.js'
import {
  DEFAULT_OPTIONS,
  nameOf,
  parseLaunchOptions,
  regionOf,
  toSearch,
  type LaunchOptions,
} from './shell/options.js'
import { LaunchScreen, PauseMenu, deviceCanFly } from './shell/screens.js'
import { buildCourse } from './course.js'
import { buildGates } from './terrain/gates.js'
import { captureSituation, parseSituation, applySlew, speedOf } from './situation.js'
import { PHYSICS_DT, fpsToKt, mToFt, referenceSpeed } from '@retro-flyer/physics'
import { buildBridges } from './terrain/bridges.js'
import { buildLandmarks } from './terrain/landmarks.js'
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
function nearestFieldElevationFt(
  airfields: readonly Airfield[],
  x: number,
  z: number,
): number {
  let best = airfields[0]
  let bestDistance = Infinity

  for (const field of airfields) {
    const d = Math.hypot(field.x - x, field.z - z)
    if (d < bestDistance) {
      bestDistance = d
      best = field
    }
  }

  return best ? mToFt(best.elevation) : 0
}

/** How far you can see, metres. The outer LOD ring goes further; fog hides its edge. */
const VIEW_DISTANCE = 42_000

const SKY = 0x86b0d6
const HAZE = 0xb3c8d6

/**
 * Which world to fly in.
 *
 * The choice now arrives from the launch screen rather than from the query string,
 * but it means the same thing and `?region=` still selects it — see
 * `shell/options.ts`. The authored map remains the default: it is deterministic,
 * needs no network, and is what every existing test and the whole of Days 1-4 were
 * flown against. A real region is three megabytes over the wire.
 *
 * A failure is now reported rather than swallowed. It used to log and hand back the
 * authored map, which was right when a region was something you opted into by typing
 * a parameter — silently delivering a different world to someone who has just picked
 * a city on a screen is not.
 */
async function chooseMap(options: LaunchOptions): Promise<TerrainSource> {
  const region = regionOf(options)
  if (!region) return authoredMap

  if (!isRegionId(region)) {
    console.warn(`unknown region "${region}"; falling back to the authored map`)
    return authoredMap
  }

  return await loadRegion(region)
}

/**
 * Where this flight begins.
 *
 * `airfields` is ordered longest first by the builder, so "the first one" is Kennedy
 * in New York and O'Hare in Chicago rather than whichever GA strip happened to sort
 * first. The authored map keeps the hand-placed Day 2 spawn for its airborne start,
 * whose coordinates were chosen to point at the ridge and only mean anything there.
 */
function startCondition(map: TerrainSource, options: LaunchOptions): SpawnCondition {
  const field = map.airfields[0]!

  if (options.spawn === 'runway') return runwayStart(field)
  return map === authoredMap ? SPAWN : airborneStart(field, map)
}

async function main(options: LaunchOptions, screen?: LaunchScreen): Promise<void> {
  const map = await chooseMap(options)

  // Let the loading line paint before the build phase below, which runs for a while
  // without yielding — five LOD rings, the buildings, the scatter, the minimap
  // raster and a trim solve. Without this the screen says LOADING and then freezes
  // on it, which reads as a hang rather than as work.
  //
  // A frame *or* a timer, whichever arrives first, and the timer is the one that
  // matters. Chrome does not run `requestAnimationFrame` at all in a background tab —
  // the note on `step` below says so — so waiting on a frame alone means that anyone
  // who presses FLY and then switches tab never comes back to a loaded world. It
  // waits on a frame that will not be delivered until they return, and on some
  // platforms not even then. The timer always fires.
  await Promise.race([
    new Promise((resolve) => requestAnimationFrame(resolve)),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ])

  const start = startCondition(map, options)
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
  scene.fog = new Fog(HAZE, VIEW_DISTANCE * 0.45, VIEW_DISTANCE)

  const camera = new PerspectiveCamera(58, 1, 2, VIEW_DISTANCE * 1.3)

  // Flat shading needs a real directional source or every face reads the same. The
  // light direction and the visible sun disc share `SUN_DIRECTION`, so the shadows
  // point away from the thing casting them.
  const sunLight = new DirectionalLight(0xfff2df, 2.15)
  sunLight.position.copy(SUN_DIRECTION)
  scene.add(sunLight, new AmbientLight(0x93a9c4, 1.25))

  // The sea. Terrain below zero is seabed; this is the surface over it.
  const sea = new Mesh(
    new PlaneGeometry(map.extent * 6, map.extent * 6),
    new MeshBasicMaterial({ color: 0x1b4a68 }),
  )
  sea.rotation.x = -Math.PI / 2
  sea.position.y = 0
  sea.renderOrder = -10
  scene.add(sea)

  const terrain = new TerrainMesh(map)
  terrain.buildAll(start.x, start.z)
  scene.add(terrain.object)
  scene.add(buildCity(map))
  scene.add(buildRunways(map))
  scene.add(buildBridges(map))
  scene.add(buildLandmarks(map))

  const scatter = new Scatter(map)
  scene.add(scatter.mesh)

  // Rasterised once from the terrain source, so it costs a blit a frame afterwards.
  const minimap = new Minimap(map)
  document.body.append(minimap.canvas)

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
  const groundSource = new TerrainGroundSource(map)

  const simulation = new Simulation(start, undefined, groundSource)
  const input = new InputReader()
  input.setThrottle(simulation.trimThrottle)

  const course = buildCourse(map.airfields)
  scene.add(buildGates(course.waypoints))

  let slewing = false
  let fieldIndex = 0

  const SAVE_KEY = 'retro-flyer.situation'

  const chase = new ChaseCamera()
  const fov = new FovController()
  const overlay = new Overlay()
  const hud = new Hud()
  // Closed: the launch screen has already shown this list, and opening it again over
  // the first frame of flight puts it between the pilot and the aeroplane. `/` still
  // brings it back.
  const help = new HelpCard(document.body, false)

  // Rebuilt every frame rather than allocated every frame. `Matrix4.elements` is the
  // column-major array `projectDirection` wants, so no conversion happens anywhere.
  const viewProj = new Matrix4()

  let mode: CameraMode = 'chase'
  let presetIndex = 0
  // Down for a runway start, up for an airborne one. Starting the Day 2 spawn with
  // the wheels hanging out is not a small thing to get wrong: it is the first thing
  // anyone sees, and it says the aircraft has just taken off when it has not.
  // From the spawn actually used, not from `SPAWN`. A region starts on a runway, and
  // starting on a runway with the gear retracted is a wheels-up departure.
  let gearDown = start.onGround === true
  let parkingBrake = false
  /**
   * Whether the aircraft is rolling out after a landing.
   *
   * Being on the ground with the gear down looks identical to a takeoff roll, and
   * before Day 4's QA pass the HUD acted on that resemblance: it displayed ROTATE
   * for the whole landing rollout. Distinguishing them needs one bit of history —
   * has this aircraft been in the air since it last touched the ground.
   *
   * It clears again below walking pace, so that after coming to a stop the next roll
   * is a takeoff again and the cue comes back without needing a reset.
   */
  let rollingOut = false
  // From the spawn actually used. Reading `SPAWN` here was the same mistake already
  // fixed two lines up for `gearDown`: on a runway start it claims the aircraft has
  // just been flying, which is what `rollingOut` keys off.
  let wasAirborne = start.onGround !== true
  let wasSlewing = false
  let saveNote = ''
  let saveNoteUntil = 0
  // Primed from the real start condition. Priming it with a hardcoded airborne sample
  // flipped the course to 'running' before the first frame — so a runway start sat at
  // the threshold with the clock already going, which is precisely what
  // `Course.update` says it avoids ("the clock starts at liftoff, not at spawn").
  let courseProgress = course.update(
    {
      x: start.x,
      z: start.z,
      altFt: start.alt,
      onGround: start.onGround === true,
      speedFps: start.vt,
    },
    0,
  )

  /**
   * Put the aircraft back at the beginning of a flight.
   *
   * This block used to exist only inside the `nextField` handler, which meant the one
   * piece of code that knows everything a fresh flight has to reset was reachable only
   * by pressing `T`. The pause menu needs the same thing, so it is a function.
   *
   * The list is not obvious and every item on it was learned: the parking brake
   * survives a reset otherwise, the course keeps its old splits, the gear stays
   * wherever it was, the throttle keeps its previous setting, and the chase camera
   * arrives still swinging from wherever the aircraft used to be.
   */
  const startFlight = (spawn: SpawnCondition, index: number): void => {
    parkingBrake = false
    fieldIndex = index
    simulation.reset(spawn)
    course.reset()
    gearDown = spawn.onGround === true
    input.setThrottle(spawn.onGround === true ? 0 : simulation.trimThrottle)
    chase.reset()
    slewing = false
    rollingOut = false
    wasAirborne = spawn.onGround !== true
  }

  /**
   * The menu, and the flag that stops the world while it is up.
   *
   * `simulation.paused` is deliberately not reused. It already exists and gates the
   * physics correctly, but slew writes it too — leaving slew clears it unconditionally
   * — so a menu built on it could be un-paused by a keystroke it never saw.
   */
  let menuOpen = false

  const closeMenu = (): void => {
    menu.hide()
    menuOpen = false
    // The resume frame would otherwise carry the whole time the menu was open, capped
    // at 0.25 s, which is a quarter second of camera smoothing and throttle ramp in
    // one step.
    last = performance.now()
  }

  const menu = new PauseMenu({
    onResume: closeMenu,
    onRestart: () => {
      startFlight(startCondition(map, options), 0)
      closeMenu()
    },
    // A reload, on purpose. Nothing in this codebase disposes of a terrain mesh, and
    // the terrain, the scatter, the minimap and the simulation all take the map as a
    // `private readonly` constructor argument — so swapping worlds in place is a
    // rewrite, not a menu item. `replace` rather than an assignment because the URL
    // is often the one already in the bar, which would otherwise do nothing.
    onChangeWorld: () => {
      location.replace(location.pathname + toSearch(options))
    },
  })

  /**
   * Escape opens and closes the menu.
   *
   * Handled here rather than through `InputCommands` for a specific reason: `step`
   * stops draining commands while the menu is open, so an Escape routed through that
   * queue would open the menu and then never be seen again. This listener is outside
   * the queue and works in both directions.
   *
   * `Escape` is deliberately not added to the claimed set — the browser uses it to
   * leave full screen, and taking that away would trap anyone who had gone full screen
   * to fly.
   */
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.code !== 'Escape') return
    if (menuOpen) {
      closeMenu()
    } else {
      menuOpen = true
      menu.show()
      // Whatever was held will never see its keyup while the menu has focus, and the
      // aircraft would come back with the stick still over.
      input.releaseAll()
    }
  })

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
  const step = (rawDt: number): void => {
    // While the menu is up the world is still drawn but does not move. A zero step
    // means no physics ticks, no camera smoothing, no course time and no fuel — the
    // scene behind the panel is the frame the pilot paused on.
    //
    // Commands are not drained at all rather than drained and ignored, because
    // `commands()` empties the queue: reading it here would swallow whatever was
    // typed while the menu was open and then do nothing with it.
    const running = !menuOpen
    const dt = running ? rawDt : 0
    const commands = running ? input.commands() : NO_COMMANDS

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
    if (commands.cycleMap) minimap.cycle()
    if (commands.toggleParkingBrake) parkingBrake = !parkingBrake
    if (commands.toggleHud) hud.visible = !hud.visible
    if (commands.toggleOverlay) overlay.visible = !overlay.visible
    if (commands.toggleHelp) help.toggle()

    // --- Day 3 -----------------------------------------------------------
    if (commands.toggleGear) gearDown = !gearDown
    if (commands.toggleSlew) slewing = !slewing

    if (commands.nextField) {
      // Cycle the airfields, starting on the runway at each. This is how a takeoff
      // gets flown without first flying to the field.
      const next = (fieldIndex + 1) % map.airfields.length
      startFlight(runwayStart(map.airfields[next]!), next)
    }

    if (commands.saveSituation) {
      try {
        localStorage.setItem(
          SAVE_KEY,
          JSON.stringify(
            captureSituation(
              simulation.capture(),
              { ...simulation.layer.toggles },
              presetIndex,
              options.map,
            ),
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

      if (situation && situation.region !== options.map) {
        // The coordinates in it belong to a different world. Restoring them here would
        // not fail, it would put the aircraft somewhere that means nothing.
        saveNote = `SAVED IN ${nameOf(situation.region).toUpperCase()}`
      } else if (situation) {
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

    // `PHYSICS_DT`, not `dt`. `FixedStepClock` calls this closure once per physics
    // tick, not once per frame, and `axes` ramps the throttle by its argument — so
    // passing the frame delta ramped it once per tick at the frame rate, about twice
    // as fast as intended at 60 fps, and slammed it to full travel on the first frame
    // after any stall (30 ticks x 0.25 s of ramp in one go).
    simulation.advance(dt, () => input.axes(PHYSICS_DT))

    const state = simulation.render()

    if (!simulation.onGround) rollingOut = false
    else if (wasAirborne) rollingOut = true
    if (simulation.onGround && state.kt < 5) rollingOut = false
    wasAirborne = !simulation.onGround

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
      referenceSpeed(nearestFieldElevationFt(map.airfields, state.position[0], state.position[2])),
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
        rollingOut,
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

    // After the scene, before the HUD: it is a 2D overlay and shares nothing with
    // the WebGL context, so where it goes only affects what sits on top of what.
    minimap.draw(state.position[0], state.position[2], state.headingDeg)

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
        rollingOut,
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
      map,
      course,
      groundSource,
      step,
      startAt: (name: string) => {
        const i = map.airfields.findIndex((a) => a.name === name)
        if (i < 0) return false
        fieldIndex = i
        simulation.reset(runwayStart(map.airfields[i]!))
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
      menu,
    },
  })

  screen?.hide()
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/** Where the last launch choice is remembered. */
const LAUNCH_KEY = 'retro-flyer.launch'

function readLaunch(): string | null {
  try {
    return localStorage.getItem(LAUNCH_KEY)
  } catch {
    // A private window, or storage disabled. Not remembering is not a failure.
    return null
  }
}

function rememberLaunch(options: LaunchOptions): void {
  try {
    localStorage.setItem(LAUNCH_KEY, JSON.stringify(options))
  } catch {
    // As above.
  }
}

/**
 * Start the page.
 *
 * Three ways in, and the order matters.
 *
 * A device that cannot fly is turned away first, before any world is chosen and long
 * before three megabytes of one is fetched. `?autostart=1` then goes straight through
 * without a screen, which the browser QA workflow depends on — `window.__rf` only
 * exists once `main` has run, and the automation polls for it. Everyone else gets the
 * launch screen.
 */
function boot(): void {
  document.getElementById('boot')?.remove()

  const parsed = parseLaunchOptions(location.search, readLaunch())

  if (!parsed.forceDesktop && !deviceCanFly()) {
    new LaunchScreen(parsed.options, { onFly: () => {} }).gate()
    return
  }

  if (parsed.autostart) {
    void main(parsed.options)
    return
  }

  const screen: LaunchScreen = new LaunchScreen(parsed.options, {
    onFly: (options) => {
      rememberLaunch(options)
      screen.loading(nameOf(options.map))

      void main(options, screen).catch((error: unknown) => {
        console.error('failed to start', error)
        screen.failed(
          `Could not load ${nameOf(options.map)}. Check the connection and try again, ` +
            `or fly ${nameOf(DEFAULT_OPTIONS.map)} instead.`,
        )
      })
    },
  })
}

boot()
