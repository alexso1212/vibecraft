/**
 * TrumpCharacter - GLB model character with Mixamo skeleton
 *
 * Loads a rigged GLB model and drives procedural bone animations
 * for idle, walking, working, and thinking states.
 * Drop-in replacement for ClaudeMon.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { StationType } from '../../shared/types'
import type { WorkshopScene } from '../scene/WorkshopScene'
import type { ICharacter, CharacterOptions, CharacterState } from './ICharacter'
import {
  IdleBehaviorManager,
  WorkingBehaviorManager,
  STATION_ANIMATIONS,
  type CharacterParts,
} from './animations'

export type ClaudeState = CharacterState
export type ClaudeOptions = CharacterOptions

const DEFAULT_OPTIONS: Required<ClaudeOptions> = {
  scale: 1,
  color: 0xd4a574,
  statusColor: 0x4ade80,
  startStation: 'center',
}

// Mixamo bone names (this GLB uses "mixamorigX" without colon)
const BONE = {
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  spine1: 'mixamorigSpine1',
  spine2: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  leftShoulder: 'mixamorigLeftShoulder',
  leftArm: 'mixamorigLeftArm',
  leftForeArm: 'mixamorigLeftForeArm',
  leftHand: 'mixamorigLeftHand',
  rightShoulder: 'mixamorigRightShoulder',
  rightArm: 'mixamorigRightArm',
  rightForeArm: 'mixamorigRightForeArm',
  rightHand: 'mixamorigRightHand',
  leftUpLeg: 'mixamorigLeftUpLeg',
  leftLeg: 'mixamorigLeftLeg',
  leftFoot: 'mixamorigLeftFoot',
  rightUpLeg: 'mixamorigRightUpLeg',
  rightLeg: 'mixamorigRightLeg',
  rightFoot: 'mixamorigRightFoot',
} as const

export class Claude implements ICharacter {
  public readonly mesh: THREE.Group
  public state: CharacterState = 'idle'
  public currentStation: StationType = 'center'
  public readonly id: string

  private scene: WorkshopScene
  private options: Required<ClaudeOptions>
  private targetPosition: THREE.Vector3 | null = null
  private moveSpeed = 3
  private bobTime = 0
  private workTime = 0
  private thinkTime = 0
  private updateCallback: ((delta: number) => void) | null = null

  // Skeleton bones (populated after model loads)
  private bones: Map<string, THREE.Bone> = new Map()
  private modelLoaded = false

  // AnimationMixer for pre-baked GLB animations
  private mixer: THREE.AnimationMixer | null = null
  private clips: THREE.AnimationClip[] = []
  private currentAction: THREE.AnimationAction | null = null
  private useBakedAnimation = false

  // Proxy parts for the animation system (ClaudeMon compatibility)
  private headGroup: THREE.Group
  private leftEyeMesh: THREE.Mesh
  private rightEyeMesh: THREE.Mesh
  private bodyGroup: THREE.Group
  private leftArmGroup: THREE.Group
  private rightArmGroup: THREE.Group
  private antennaGroup: THREE.Group

  // Status indicator (floating ring above head)
  private statusRing: THREE.Mesh
  private thoughtBubbles: THREE.Group

  // Behavior systems
  private idleBehaviorManager: IdleBehaviorManager
  private workingBehaviorManager: WorkingBehaviorManager

  // Store rest pose rotations
  private restPose: Map<string, THREE.Quaternion> = new Map()

  constructor(scene: WorkshopScene, options: ClaudeOptions = {}) {
    this.scene = scene
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.id = Math.random().toString(36).substring(2, 9)
    this.mesh = new THREE.Group()

    // Create proxy groups (animation system expects these)
    this.headGroup = new THREE.Group()
    this.headGroup.position.set(0, 0.52, 0)
    this.leftEyeMesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.01, 8),
      new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0 })
    )
    this.leftEyeMesh.position.set(-0.07, 0.03, 0.242)
    this.rightEyeMesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.01, 8),
      new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0 })
    )
    this.rightEyeMesh.position.set(0.07, 0.03, 0.242)
    this.bodyGroup = new THREE.Group()
    this.leftArmGroup = new THREE.Group()
    this.rightArmGroup = new THREE.Group()
    this.antennaGroup = new THREE.Group()

    // Status ring (floating above character)
    this.statusRing = this.createStatusRing()
    this.mesh.add(this.statusRing)

    // Thought bubbles
    this.thoughtBubbles = this.createThoughtBubbles()
    this.mesh.add(this.thoughtBubbles)

    // Initialize behavior systems
    this.idleBehaviorManager = new IdleBehaviorManager()
    this.workingBehaviorManager = new WorkingBehaviorManager()

    // Load the GLB model
    this.loadModel()

    // Position at start station
    this.currentStation = this.options.startStation
    const startStation = scene.stations.get(this.options.startStation)
    if (startStation) {
      this.mesh.position.copy(startStation.position)
    }

    // Add to scene
    scene.scene.add(this.mesh)

    // Register update
    this.updateCallback = (delta: number) => this.update(delta)
    scene.onRender(this.updateCallback)
  }

  private async loadModel(): Promise<void> {
    const loader = new GLTFLoader()
    try {
      const gltf = await loader.loadAsync('/models/trump.glb')
      const model = gltf.scene

      // Scale and position the model to match ClaudeMon's size (~1.3m)
      // Mixamo models are typically ~1.7m, scale to fit
      const box = new THREE.Box3().setFromObject(model)
      const height = box.max.y - box.min.y
      const targetHeight = 0.9 // Slightly shorter than ClaudeMon
      const scale = targetHeight / height
      model.scale.setScalar(scale)

      // Center the model horizontally and put feet on ground
      box.setFromObject(model)
      model.position.y = -box.min.y
      model.position.x = -(box.max.x + box.min.x) / 2
      model.position.z = -(box.max.z + box.min.z) / 2

      // Extract bones from skeleton — use SkinnedMesh.skeleton for reliable access
      model.traverse((child) => {
        if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
          const skeleton = (child as THREE.SkinnedMesh).skeleton
          for (const bone of skeleton.bones) {
            this.bones.set(bone.name, bone)
            this.restPose.set(bone.name, bone.quaternion.clone())
          }
        }
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true
          child.receiveShadow = true
        }
      })

      this.mesh.add(model)
      this.modelLoaded = true

      // Position status ring above head
      this.statusRing.position.y = targetHeight + 0.15

      console.log(`[TrumpCharacter] loaded: ${this.bones.size} bones`)
    } catch (err) {
      console.error('Failed to load Trump model:', err)
      // Fallback: create a simple capsule placeholder
      this.createFallback()
    }
  }

  private createFallback(): void {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.15, 0.4, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0xd4a574 })
    )
    body.position.y = 0.35
    body.castShadow = true
    this.mesh.add(body)

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xf0c8a0 })
    )
    head.position.y = 0.7
    head.castShadow = true
    this.mesh.add(head)

    this.statusRing.position.y = 0.9
    this.modelLoaded = true
  }

  private getBone(name: string): THREE.Bone | undefined {
    return this.bones.get(name)
  }

  private resetBonesToRest(): void {
    for (const [name, bone] of this.bones) {
      const rest = this.restPose.get(name)
      if (rest) {
        bone.quaternion.copy(rest)
      }
    }
  }

  // Rotate a bone relative to its rest pose
  private rotateBone(name: string, x: number, y: number, z: number): void {
    const bone = this.getBone(name)
    if (!bone) return
    const rest = this.restPose.get(name)
    if (rest) {
      bone.quaternion.copy(rest)
    }
    const euler = new THREE.Euler(x, y, z)
    const q = new THREE.Quaternion().setFromEuler(euler)
    bone.quaternion.multiply(q)
  }

  private createStatusRing(): THREE.Mesh {
    const geometry = new THREE.RingGeometry(0.12, 0.15, 6)
    const material = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(geometry, material)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 1.1
    return ring
  }

  private createThoughtBubbles(): THREE.Group {
    const group = new THREE.Group()
    const sizes = [0.04, 0.06, 0.09]
    const positions = [
      { x: 0.3, y: 0.75, z: 0.1 },
      { x: 0.42, y: 0.9, z: 0.12 },
      { x: 0.52, y: 1.1, z: 0.14 },
    ]

    sizes.forEach((size, i) => {
      const geometry = new THREE.CircleGeometry(size, 6)
      const material = new THREE.MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.6,
      })
      const bubble = new THREE.Mesh(geometry, material)
      bubble.position.set(positions[i].x, positions[i].y, positions[i].z)
      bubble.rotation.z = Math.PI / 6
      bubble.userData.baseY = positions[i].y
      bubble.userData.offset = i * 0.7
      group.add(bubble)
    })

    group.visible = false
    return group
  }

  moveTo(station: StationType): void {
    const targetStation = this.scene.stations.get(station)
    if (!targetStation) {
      console.warn(`Unknown station: ${station}`)
      return
    }
    this.targetPosition = targetStation.position.clone()
    this.currentStation = station
    this.state = 'walking'
    this.updateStatusColor()
  }

  moveToPosition(position: THREE.Vector3, station: StationType): void {
    this.targetPosition = position.clone()
    this.currentStation = station
    this.state = 'walking'
    this.updateStatusColor()
  }

  setState(state: ClaudeState): void {
    const parts = this.getCharacterParts()

    if (this.state === 'idle' && state !== 'idle') {
      this.idleBehaviorManager.stop(parts)
    }
    if (this.state === 'working' && state !== 'working') {
      this.workingBehaviorManager.stop(parts)
    }

    this.state = state
    this.updateStatusColor()

    if (state === 'working') {
      this.workTime = 0
      this.workingBehaviorManager.start(this.currentStation, parts)
    } else if (state === 'thinking') {
      this.thinkTime = 0
    }
  }

  private getCharacterParts(): CharacterParts {
    return {
      head: this.headGroup,
      leftEye: this.leftEyeMesh,
      rightEye: this.rightEyeMesh,
      leftArm: this.leftArmGroup,
      rightArm: this.rightArmGroup,
      antenna: this.antennaGroup,
      body: this.bodyGroup,
      mesh: this.mesh,
    }
  }

  private updateStatusColor(): void {
    const material = this.statusRing.material as THREE.MeshBasicMaterial
    switch (this.state) {
      case 'idle':
        material.color.setHex(0x4ade80)
        material.opacity = 0.5
        break
      case 'walking':
        material.color.setHex(0x60a5fa)
        material.opacity = 0.6
        break
      case 'working':
        material.color.setHex(0xfbbf24)
        material.opacity = 0.7
        break
      case 'thinking':
        material.color.setHex(0xa78bfa)
        material.opacity = 0.6
        break
    }
  }

  private update(delta: number): void {
    // === Movement ===
    if (this.targetPosition && this.state === 'walking') {
      const direction = this.targetPosition.clone().sub(this.mesh.position)
      const distance = direction.length()

      if (distance > 0.1) {
        direction.normalize()
        const moveDistance = Math.min(this.moveSpeed * delta, distance)
        this.mesh.position.add(direction.multiplyScalar(moveDistance))

        // Face movement direction
        const angle = Math.atan2(direction.x, direction.z)
        this.mesh.rotation.y = angle

        // Walk animation on skeleton
        this.bobTime += delta * 8
        if (this.modelLoaded && this.bones.size > 0) {
          this.animateWalk(this.bobTime)
        }
      } else {
        this.mesh.position.copy(this.targetPosition)
        this.targetPosition = null
        if (this.modelLoaded) this.resetBonesToRest()
        this.setState(this.currentStation === 'center' ? 'idle' : 'working')
      }
    }

    // === AnimationMixer update (baked animations) ===
    if (this.mixer) {
      this.mixer.update(delta)
    }

    // === Idle animation (Trump dance) ===
    if (this.state === 'idle' && !this.useBakedAnimation) {
      this.bobTime += delta * 2

      if (this.modelLoaded && this.bones.size > 0) {
        this.animateIdle(this.bobTime)
      }
    }

    // === Working animation ===
    if (this.state === 'working' && !this.useBakedAnimation) {
      this.workTime += delta

      if (this.modelLoaded && this.bones.size > 0) {
        this.animateWorking(this.workTime)
      }

      // Thought bubbles
      this.thinkTime += delta * 3
      this.thoughtBubbles.visible = true
      this.thoughtBubbles.scale.setScalar(0.5)
      this.thoughtBubbles.children.forEach((bubble) => {
        const mesh = bubble as THREE.Mesh
        const baseY = mesh.userData.baseY as number
        const offset = mesh.userData.offset as number
        mesh.position.y = baseY + Math.sin(this.thinkTime * 3 + offset) * 0.03
        const mat = mesh.material as THREE.MeshBasicMaterial
        mat.opacity = 0.3 + Math.sin(this.thinkTime * 4 + offset) * 0.2
      })
    }

    // === Thinking animation ===
    if (this.state === 'thinking' && !this.useBakedAnimation) {
      this.thinkTime += delta * 2

      if (this.modelLoaded && this.bones.size > 0) {
        this.animateThinking(this.thinkTime)
      }

      // Full thought bubbles
      this.thoughtBubbles.visible = true
      this.thoughtBubbles.scale.setScalar(1)
      this.thoughtBubbles.children.forEach((bubble) => {
        const mesh = bubble as THREE.Mesh
        const baseY = mesh.userData.baseY as number
        const offset = mesh.userData.offset as number
        mesh.position.y = baseY + Math.sin(this.thinkTime * 2 + offset) * 0.05
        const mat = mesh.material as THREE.MeshBasicMaterial
        mat.opacity = 0.5 + Math.sin(this.thinkTime * 3 + offset) * 0.3
      })
    } else if (this.state !== 'working') {
      this.thoughtBubbles.visible = false
    }

    // Status ring rotation
    this.statusRing.rotation.z += delta * 0.3
  }

  // ===== Procedural bone animations =====

  private animateIdle(t: number): void {
    // Trump rally dance — alternating fist pumps with body sway
    const beat = t * 2.2 // ~132 BPM feel
    const bounce = Math.abs(Math.sin(beat)) // knee bounce rhythm

    // Body sway side-to-side (exaggerated for visibility)
    this.rotateBone(BONE.hips, 0, 0, Math.sin(beat * 0.5) * 0.25)
    this.rotateBone(BONE.spine, 0.05, 0, Math.sin(beat * 0.5) * 0.15)
    this.rotateBone(BONE.spine1, 0, 0, Math.sin(beat * 0.5) * 0.1)

    // Knee bounce
    this.rotateBone(BONE.leftUpLeg, bounce * 0.2, 0, 0)
    this.rotateBone(BONE.rightUpLeg, bounce * 0.2, 0, 0)
    this.rotateBone(BONE.leftLeg, -bounce * 0.35, 0, 0)
    this.rotateBone(BONE.rightLeg, -bounce * 0.35, 0, 0)

    // Alternating fist pump — arms bent, pumping up and down
    const leftPump = Math.max(0, Math.sin(beat))
    const rightPump = Math.max(0, Math.sin(beat + Math.PI))

    // Left arm: bent at elbow, pumps up
    this.rotateBone(BONE.leftArm, -0.8 - leftPump * 0.8, 0, 0.5)
    this.rotateBone(BONE.leftForeArm, -1.5 + leftPump * 0.7, 0, 0)
    this.rotateBone(BONE.leftHand, -0.4, 0, 0)

    // Right arm: bent at elbow, pumps up (opposite phase)
    this.rotateBone(BONE.rightArm, -0.8 - rightPump * 0.8, 0, -0.5)
    this.rotateBone(BONE.rightForeArm, -1.5 + rightPump * 0.7, 0, 0)
    this.rotateBone(BONE.rightHand, -0.4, 0, 0)

    // Head bobs with the beat, visible tilt
    this.rotateBone(BONE.head, bounce * 0.1, Math.sin(beat * 0.5) * 0.15, 0)
    this.rotateBone(BONE.neck, bounce * 0.06, 0, 0)
  }

  private animateWalk(t: number): void {
    const stride = 0.4
    const armSwing = 0.5

    // Hips sway
    this.rotateBone(BONE.hips, 0, Math.sin(t) * 0.05, Math.sin(t * 2) * 0.03)

    // Legs
    this.rotateBone(BONE.leftUpLeg, Math.sin(t) * stride, 0, 0)
    this.rotateBone(BONE.rightUpLeg, Math.sin(t + Math.PI) * stride, 0, 0)
    this.rotateBone(BONE.leftLeg, Math.max(0, -Math.sin(t)) * stride * 0.8, 0, 0)
    this.rotateBone(BONE.rightLeg, Math.max(0, -Math.sin(t + Math.PI)) * stride * 0.8, 0, 0)

    // Arms (opposite to legs)
    this.rotateBone(BONE.leftArm, Math.sin(t + Math.PI) * armSwing, 0, 0)
    this.rotateBone(BONE.rightArm, Math.sin(t) * armSwing, 0, 0)
    this.rotateBone(BONE.leftForeArm, -0.2 + Math.sin(t) * 0.15, 0, 0)
    this.rotateBone(BONE.rightForeArm, -0.2 + Math.sin(t + Math.PI) * 0.15, 0, 0)

    // Spine bounce
    this.rotateBone(BONE.spine, Math.abs(Math.sin(t)) * 0.03, 0, Math.sin(t) * 0.02)
    this.rotateBone(BONE.head, -Math.abs(Math.sin(t)) * 0.02, 0, 0)
  }

  private animateWorking(t: number): void {
    // Typing-like motion
    this.rotateBone(BONE.spine, -0.15, 0, 0) // Lean forward
    this.rotateBone(BONE.spine1, -0.1, 0, 0)
    this.rotateBone(BONE.head, -0.05 + Math.sin(t * 2) * 0.03, Math.sin(t * 0.5) * 0.05, 0)
    this.rotateBone(BONE.neck, -0.05, 0, 0)

    // Arms forward for typing
    this.rotateBone(BONE.leftArm, -0.8, 0, 0.3)
    this.rotateBone(BONE.rightArm, -0.8, 0, -0.3)
    this.rotateBone(BONE.leftForeArm, -0.6 + Math.sin(t * 6) * 0.1, 0, 0)
    this.rotateBone(BONE.rightForeArm, -0.6 + Math.sin(t * 6 + 1) * 0.1, 0, 0)
    this.rotateBone(BONE.leftHand, Math.sin(t * 8) * 0.15, 0, 0)
    this.rotateBone(BONE.rightHand, Math.sin(t * 8 + 0.5) * 0.15, 0, 0)
  }

  private animateThinking(t: number): void {
    // Hand on chin pose
    this.rotateBone(BONE.spine, 0, Math.sin(t * 0.3) * 0.03, 0)
    this.rotateBone(BONE.head, Math.sin(t * 0.5) * 0.05, Math.sin(t * 0.3) * 0.08, Math.sin(t * 0.4) * 0.05)
    this.rotateBone(BONE.neck, 0.05, 0, Math.sin(t * 0.4) * 0.03)

    // Right hand to chin
    this.rotateBone(BONE.rightArm, -1.2, 0, -0.4)
    this.rotateBone(BONE.rightForeArm, -1.5 + Math.sin(t) * 0.05, 0, 0)

    // Left arm relaxed
    this.rotateBone(BONE.leftArm, 0.1 + Math.sin(t * 0.7) * 0.05, 0, 0)
    this.rotateBone(BONE.leftForeArm, -0.1, 0, 0)

    // Weight shift
    this.rotateBone(BONE.hips, 0, 0, Math.sin(t * 0.3) * 0.02)
    this.rotateBone(BONE.leftUpLeg, 0.05, 0, 0)
    this.rotateBone(BONE.rightUpLeg, -0.05, 0, 0)
  }

  // ===== Baked Animation Support =====

  /** Load a GLB with pre-baked animation and play it */
  async loadAnimation(glbPath: string): Promise<void> {
    const loader = new GLTFLoader()
    try {
      const gltf = await loader.loadAsync(glbPath)

      if (gltf.animations.length === 0) {
        console.warn(`[TrumpCharacter] No animations found in ${glbPath}`)
        return
      }

      // If the GLB has its own model, replace current
      if (gltf.scene.children.length > 0) {
        // Remove old model children (keep status ring and thought bubbles)
        const toRemove = this.mesh.children.filter(
          (c) => c !== this.statusRing && c !== this.thoughtBubbles
        )
        toRemove.forEach((c) => this.mesh.remove(c))

        const model = gltf.scene
        const box = new THREE.Box3().setFromObject(model)
        const height = box.max.y - box.min.y
        const scale = 0.9 / height
        model.scale.setScalar(scale)
        box.setFromObject(model)
        model.position.y = -box.min.y
        model.position.x = -(box.max.x + box.min.x) / 2
        model.position.z = -(box.max.z + box.min.z) / 2
        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = true
            child.receiveShadow = true
          }
        })
        this.mesh.add(model)

        // Set up mixer on the new model
        this.mixer = new THREE.AnimationMixer(model)
      } else {
        // Use mixer on existing mesh
        this.mixer = new THREE.AnimationMixer(this.mesh)
      }

      this.clips = gltf.animations
      this.useBakedAnimation = true

      // Play first clip
      this.playClip(0)

      console.log(
        `[TrumpCharacter] loaded animation: ${this.clips.length} clips from ${glbPath}`
      )
    } catch (err) {
      console.error(`[TrumpCharacter] failed to load animation: ${glbPath}`, err)
    }
  }

  /** Play a specific animation clip by index */
  playClip(index: number): void {
    if (!this.mixer || index >= this.clips.length) return
    if (this.currentAction) {
      this.currentAction.fadeOut(0.3)
    }
    const action = this.mixer.clipAction(this.clips[index])
    action.reset().fadeIn(0.3).play()
    this.currentAction = action
  }

  /** Stop baked animation and return to procedural */
  stopBakedAnimation(): void {
    if (this.currentAction) {
      this.currentAction.fadeOut(0.3)
      this.currentAction = null
    }
    this.useBakedAnimation = false
    this.mixer = null
    this.clips = []
  }

  // ===== Dev/Debug API (ClaudeMon compatibility) =====

  getIdleBehaviorNames(): string[] {
    return this.idleBehaviorManager.getBehaviorNames()
  }

  playIdleBehavior(name: string): boolean {
    if (this.state !== 'idle') this.setState('idle')
    return this.idleBehaviorManager.forcePlay(name, this.getCharacterParts())
  }

  playRandomIdleBehavior(): string | null {
    if (this.state !== 'idle') this.setState('idle')
    return this.idleBehaviorManager.forcePlayRandom(this.getCharacterParts())
  }

  getWorkingBehaviorStations(): string[] {
    return Object.keys(STATION_ANIMATIONS)
  }

  playWorkingBehavior(station: string): void {
    this.currentStation = station as StationType
    this.setState('working')
  }

  dispose(): void {
    if (this.updateCallback) {
      this.scene.offRender(this.updateCallback)
      this.updateCallback = null
    }

    this.scene.scene.remove(this.mesh)

    const disposeMesh = (obj: THREE.Object3D) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose())
        } else if (obj.material) {
          obj.material.dispose()
        }
      }
    }

    this.mesh.traverse(disposeMesh)
  }
}
