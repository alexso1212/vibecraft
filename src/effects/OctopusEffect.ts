/**
 * OctopusEffect - "Tentacle Network" for multi-AI collaboration mode
 *
 * Visual:
 * - Main zone elevates 1.5 units (command center rising)
 * - Zone floor turns deep purple
 * - Energy tentacles (TubeGeometry along Bezier curves) from main zone to subagents
 * - Pulsing light points flowing along tentacles
 *
 * Performance: Tentacles rebuilt only when subagent count changes, pulse via uniform
 */

import * as THREE from 'three'
import type { WorkshopScene, Zone } from '../scene/WorkshopScene'
import type { Claude } from '../entities/ClaudeMon'
import type { SubagentManager } from '../entities/SubagentManager'

const COMMAND_ELEVATION = 1.5
const ELEVATION_SPEED = 2.0 // units/sec for smooth rise
const FLOOR_COLOR = 0x2d1b69   // Deep purple
const FLOOR_EMISSIVE = 0x4c1d95
const TENTACLE_COLOR = 0xa78bfa  // Purple
const TENTACLE_GLOW = 0xc4b5fd
const TENTACLE_RADIUS = 0.03
const TENTACLE_SEGMENTS = 20
const PULSE_SPEED = 3.0
const PULSE_COUNT = 3 // Light points per tentacle

interface TentacleData {
  tube: THREE.Mesh
  pulses: THREE.Mesh[]
  curve: THREE.CubicBezierCurve3
  subagentId: string
}

export class OctopusEffect {
  private scene: WorkshopScene
  private active = false
  private effectGroup: THREE.Group
  private tentacles: TentacleData[] = []
  private time = 0
  private zoneId: string | null = null
  private subagentManager: SubagentManager | null = null

  // Elevation animation
  private targetElevation = 0
  private currentElevation = 0
  private elevating = false

  // Saved floor state
  private originalFloorColor = 0
  private originalFloorEmissive = 0
  private originalFloorIntensity = 0

  // Track subagent count to know when to rebuild tentacles
  private lastSubagentCount = 0

  // Shared materials
  private tentacleMaterial: THREE.MeshBasicMaterial | null = null
  private pulseMaterial: THREE.MeshBasicMaterial | null = null

  constructor(scene: WorkshopScene) {
    this.scene = scene
    this.effectGroup = new THREE.Group()
    this.effectGroup.name = 'octopus-effect'
  }

  activate(zoneId: string, _claude: Claude, subagentManager: SubagentManager): void {
    if (this.active) this.deactivate()

    this.active = true
    this.zoneId = zoneId
    this.subagentManager = subagentManager
    this.time = 0
    this.lastSubagentCount = 0

    const zone = this.scene.getZone(zoneId)
    if (!zone) return

    // Save floor state
    const floorMat = zone.floor.material as THREE.MeshStandardMaterial
    this.originalFloorColor = floorMat.color.getHex()
    this.originalFloorEmissive = floorMat.emissive.getHex()
    this.originalFloorIntensity = floorMat.emissiveIntensity

    // Apply purple command center floor
    floorMat.color.setHex(FLOOR_COLOR)
    floorMat.emissive.setHex(FLOOR_EMISSIVE)
    floorMat.emissiveIntensity = 0.3

    // Update ring to purple glow
    const ringMat = zone.ring.material as THREE.MeshBasicMaterial
    ringMat.color.setHex(TENTACLE_COLOR)
    ringMat.opacity = 0.8

    // Start elevation animation
    this.currentElevation = zone.elevation
    this.targetElevation = COMMAND_ELEVATION
    this.elevating = true

    // Add effect group to scene (not zone, since tentacles span across zones)
    this.scene.scene.add(this.effectGroup)

    // Create shared materials
    this.tentacleMaterial = new THREE.MeshBasicMaterial({
      color: TENTACLE_COLOR,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    })
    this.pulseMaterial = new THREE.MeshBasicMaterial({
      color: TENTACLE_GLOW,
      transparent: true,
      opacity: 0.9,
    })

    this.scene.onRender(this.update)
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false

    // Reverse elevation
    if (this.zoneId) {
      const zone = this.scene.getZone(this.zoneId)
      if (zone) {
        // Restore floor
        const floorMat = zone.floor.material as THREE.MeshStandardMaterial
        floorMat.color.setHex(this.originalFloorColor)
        floorMat.emissive.setHex(this.originalFloorEmissive)
        floorMat.emissiveIntensity = this.originalFloorIntensity

        const ringMat = zone.ring.material as THREE.MeshBasicMaterial
        ringMat.color.setHex(zone.color)
        ringMat.opacity = 0.4

        // Lower back down
        this.targetElevation = 0
        this.elevating = true
        // We continue the render loop briefly for lowering animation
        // Use a timer to clean up after lowering
        const lowerDuration = (this.currentElevation / ELEVATION_SPEED) * 1000 + 200
        setTimeout(() => {
          this.cleanup()
          this.scene.offRender(this.update)
        }, lowerDuration)
        return
      }
    }

    this.cleanup()
    this.scene.offRender(this.update)
    this.zoneId = null
    this.subagentManager = null
  }

  private buildTentacles(): void {
    // Clear existing tentacles
    this.clearTentacles()

    if (!this.zoneId || !this.subagentManager) return

    const zone = this.scene.getZone(this.zoneId)
    if (!zone) return

    const subagents = this.subagentManager.getAll()
    const zoneCenter = zone.group.position.clone()
    zoneCenter.y += this.currentElevation + 0.5 // Start from above zone floor

    for (const subagent of subagents) {
      const targetPos = subagent.claude.mesh.position.clone()
      targetPos.y += 0.5 // Connect to subagent's body height

      // Create Bezier curve with control points for nice arc
      const midY = Math.max(zoneCenter.y, targetPos.y) + 1.0
      const cp1 = new THREE.Vector3(
        zoneCenter.x + (targetPos.x - zoneCenter.x) * 0.3,
        midY,
        zoneCenter.z + (targetPos.z - zoneCenter.z) * 0.3
      )
      const cp2 = new THREE.Vector3(
        zoneCenter.x + (targetPos.x - zoneCenter.x) * 0.7,
        midY * 0.8,
        zoneCenter.z + (targetPos.z - zoneCenter.z) * 0.7
      )

      const curve = new THREE.CubicBezierCurve3(zoneCenter, cp1, cp2, targetPos)

      // Create tube geometry along the curve
      const tubeGeom = new THREE.TubeGeometry(curve, TENTACLE_SEGMENTS, TENTACLE_RADIUS, 6, false)
      const tube = new THREE.Mesh(tubeGeom, this.tentacleMaterial!)
      this.effectGroup.add(tube)

      // Create pulse light points along the tentacle
      const pulses: THREE.Mesh[] = []
      const pulseGeom = new THREE.SphereGeometry(0.05, 8, 8)
      for (let p = 0; p < PULSE_COUNT; p++) {
        const pulse = new THREE.Mesh(pulseGeom, this.pulseMaterial!.clone())
        this.effectGroup.add(pulse)
        pulses.push(pulse)
      }

      this.tentacles.push({
        tube,
        pulses,
        curve,
        subagentId: subagent.toolUseId,
      })
    }
  }

  private clearTentacles(): void {
    for (const t of this.tentacles) {
      this.effectGroup.remove(t.tube)
      t.tube.geometry.dispose()
      for (const p of t.pulses) {
        this.effectGroup.remove(p)
        p.geometry.dispose()
        ;(p.material as THREE.Material).dispose()
      }
    }
    this.tentacles = []
  }

  private update = (delta: number): void => {
    this.time += delta

    // Smooth elevation animation
    if (this.elevating && this.zoneId) {
      const zone = this.scene.getZone(this.zoneId)
      if (zone) {
        const diff = this.targetElevation - this.currentElevation
        if (Math.abs(diff) < 0.01) {
          this.currentElevation = this.targetElevation
          this.elevating = false
        } else {
          this.currentElevation += Math.sign(diff) * ELEVATION_SPEED * delta
          // Clamp
          if (diff > 0 && this.currentElevation > this.targetElevation) {
            this.currentElevation = this.targetElevation
          }
          if (diff < 0 && this.currentElevation < this.targetElevation) {
            this.currentElevation = this.targetElevation
          }
        }

        zone.elevation = this.currentElevation
        zone.group.position.y = this.currentElevation
      }
    }

    if (!this.active) return

    // Check if subagent count changed → rebuild tentacles
    if (this.subagentManager) {
      const count = this.subagentManager.count
      if (count !== this.lastSubagentCount) {
        this.lastSubagentCount = count
        this.buildTentacles()
      }
    }

    // Animate pulse points along tentacles
    for (const t of this.tentacles) {
      for (let i = 0; i < t.pulses.length; i++) {
        // Each pulse travels from 0 to 1 along the curve
        const baseT = (this.time * PULSE_SPEED * 0.2 + i / PULSE_COUNT) % 1.0
        const point = t.curve.getPoint(baseT)
        t.pulses[i].position.copy(point)

        // Pulse glow
        const mat = t.pulses[i].material as THREE.MeshBasicMaterial
        mat.opacity = 0.6 + Math.sin(this.time * 6 + i * 2) * 0.3
      }

      // Tentacle opacity wave
      if (this.tentacleMaterial) {
        this.tentacleMaterial.opacity = 0.4 + Math.sin(this.time * 2) * 0.2
      }
    }

    // Zone floor pulse
    if (this.zoneId) {
      const zone = this.scene.getZone(this.zoneId)
      if (zone) {
        const floorMat = zone.floor.material as THREE.MeshStandardMaterial
        floorMat.emissiveIntensity = 0.2 + Math.sin(this.time * 1.5) * 0.1
      }
    }
  }

  private cleanup(): void {
    this.clearTentacles()

    // Dispose shared materials
    if (this.tentacleMaterial) {
      this.tentacleMaterial.dispose()
      this.tentacleMaterial = null
    }
    if (this.pulseMaterial) {
      this.pulseMaterial.dispose()
      this.pulseMaterial = null
    }

    // Remove from scene
    if (this.effectGroup.parent) {
      this.effectGroup.parent.remove(this.effectGroup)
    }

    this.zoneId = null
    this.subagentManager = null
  }

  isActive(): boolean {
    return this.active
  }

  dispose(): void {
    this.deactivate()
  }
}
