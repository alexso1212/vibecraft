/**
 * SuperpowerEffect - "Trump Transformation" for multi-perspective analysis mode
 *
 * Visual:
 * - ClaudeMon gets Trump-style cosmetic overlay (golden hair, suit tint)
 * - Zone hexagon floor becomes American flag style (red/white stripes + blue star field)
 * - Sparkle/glitter particles across the zone
 *
 * Performance: Overlay meshes added to character, zone floor material swapped
 */

import * as THREE from 'three'
import type { WorkshopScene, Zone } from '../scene/WorkshopScene'
import type { Claude } from '../entities/ClaudeMon'

// Hair constants
const HAIR_COLOR = 0xffd700     // Gold
const SUIT_TINT = 0x1a1a3a     // Dark navy blue
const TIE_COLOR = 0xcc0000     // Red tie

// Flag zone colors
const FLAG_RED = 0xb22234
const FLAG_WHITE = 0xffffff
const FLAG_BLUE = 0x3c3b6e

// Sparkle particles
const SPARKLE_COUNT = 30
const SPARKLE_SPREAD = 1.8 // hex zone radius
const SPARKLE_HEIGHT = 0.5

interface TrumpOverlay {
  hairMesh: THREE.Mesh
  tieMesh: THREE.Mesh
  suitOverlay: THREE.Mesh[]
}

interface SparkleData {
  baseY: number
  phase: number
  speed: number
}

export class SuperpowerEffect {
  private scene: WorkshopScene
  private active = false
  private effectGroup: THREE.Group
  private overlay: TrumpOverlay | null = null
  private sparkles: THREE.Points | null = null
  private sparkleData: SparkleData[] = []
  private time = 0
  private zoneId: string | null = null
  private claude: Claude | null = null

  // Saved original materials for restoration
  private originalFloorEmissive: number = 0
  private originalFloorIntensity: number = 0
  private originalFloorColor: number = 0

  // Flag floor meshes (stripes + star field)
  private flagFloor: THREE.Group | null = null

  constructor(scene: WorkshopScene) {
    this.scene = scene
    this.effectGroup = new THREE.Group()
    this.effectGroup.name = 'superpower-effect'
  }

  activate(zoneId: string, claude: Claude): void {
    if (this.active) this.deactivate()

    this.active = true
    this.zoneId = zoneId
    this.claude = claude
    this.time = 0

    const zone = this.scene.getZone(zoneId)
    if (!zone) return

    zone.group.add(this.effectGroup)

    // Add Trump cosmetic overlay to character
    this.createTrumpOverlay(claude)

    // Transform zone floor to flag style
    this.createFlagFloor(zone)

    // Create sparkle particles
    this.createSparkles(zone)

    this.scene.onRender(this.update)
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false

    this.cleanup()
    this.scene.offRender(this.update)
    this.zoneId = null
    this.claude = null
  }

  private createTrumpOverlay(claude: Claude): void {
    // Golden hair - a flattened hemisphere on top of the head
    const hairGeom = new THREE.SphereGeometry(0.32, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2)
    hairGeom.scale(1.15, 0.6, 1.1) // Wide and flat
    const hairMat = new THREE.MeshStandardMaterial({
      color: HAIR_COLOR,
      roughness: 0.3,
      metalness: 0.4,
      emissive: HAIR_COLOR,
      emissiveIntensity: 0.15,
    })
    const hairMesh = new THREE.Mesh(hairGeom, hairMat)
    // Position on top of head (head is at y=0.52 in body group, which is at y=0.22)
    hairMesh.position.set(0, 0.78, -0.02) // Above head
    hairMesh.rotation.x = -0.1 // Slight backward tilt for the "swoop"

    // Red tie - thin rectangle on chest
    const tieGeom = new THREE.PlaneGeometry(0.06, 0.18)
    const tieMat = new THREE.MeshBasicMaterial({
      color: TIE_COLOR,
      side: THREE.DoubleSide,
    })
    const tieMesh = new THREE.Mesh(tieGeom, tieMat)
    tieMesh.position.set(0, 0.28, 0.2) // On the chest

    // Suit overlay - tint the body slightly (dark suit panels on sides)
    const suitPanelGeom = new THREE.PlaneGeometry(0.12, 0.25)
    const suitMat = new THREE.MeshBasicMaterial({
      color: SUIT_TINT,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const leftPanel = new THREE.Mesh(suitPanelGeom, suitMat)
    leftPanel.position.set(-0.16, 0.25, 0.15)
    leftPanel.rotation.y = 0.3
    const rightPanel = new THREE.Mesh(suitPanelGeom, suitMat.clone())
    rightPanel.position.set(0.16, 0.25, 0.15)
    rightPanel.rotation.y = -0.3

    // Add all overlays to the character mesh directly
    claude.mesh.add(hairMesh)
    claude.mesh.add(tieMesh)
    claude.mesh.add(leftPanel)
    claude.mesh.add(rightPanel)

    this.overlay = {
      hairMesh,
      tieMesh,
      suitOverlay: [leftPanel, rightPanel],
    }
  }

  private createFlagFloor(zone: Zone): void {
    this.flagFloor = new THREE.Group()
    this.flagFloor.name = 'flag-floor'

    // Save original floor state
    const floorMat = zone.floor.material as THREE.MeshStandardMaterial
    this.originalFloorColor = floorMat.color.getHex()
    this.originalFloorEmissive = floorMat.emissive.getHex()
    this.originalFloorIntensity = floorMat.emissiveIntensity

    // Override floor to white base with red emissive stripes look
    floorMat.color.setHex(FLAG_WHITE)
    floorMat.emissive.setHex(FLAG_RED)
    floorMat.emissiveIntensity = 0.15

    // Add red stripe overlays on the floor
    const stripeCount = 5
    const zoneRadius = 1.6 // Approximate hex zone radius
    for (let i = 0; i < stripeCount; i++) {
      const stripeGeom = new THREE.PlaneGeometry(zoneRadius * 2, 0.15)
      const stripeMat = new THREE.MeshBasicMaterial({
        color: FLAG_RED,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const stripe = new THREE.Mesh(stripeGeom, stripeMat)
      stripe.rotation.x = -Math.PI / 2
      stripe.position.set(0, 0.02 + i * 0.001, -zoneRadius * 0.4 + i * (zoneRadius * 0.8 / stripeCount))
      this.flagFloor.add(stripe)
    }

    // Blue star field in one corner (upper left of hex)
    const starFieldGeom = new THREE.CircleGeometry(0.5, 6) // Hexagonal
    const starFieldMat = new THREE.MeshBasicMaterial({
      color: FLAG_BLUE,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    })
    const starField = new THREE.Mesh(starFieldGeom, starFieldMat)
    starField.rotation.x = -Math.PI / 2
    starField.position.set(-0.6, 0.025, -0.6)
    this.flagFloor.add(starField)

    // Add small star dots in the blue field
    const starGeom = new THREE.CircleGeometry(0.03, 8)
    const starMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const starPositions = [
      [-0.5, -0.5], [-0.7, -0.5], [-0.6, -0.65],
      [-0.5, -0.7], [-0.7, -0.7], [-0.6, -0.5],
    ]
    for (const [x, z] of starPositions) {
      const star = new THREE.Mesh(starGeom, starMat)
      star.rotation.x = -Math.PI / 2
      star.position.set(x, 0.03, z)
      this.flagFloor.add(star)
    }

    // Update ring color to gold
    const ringMat = zone.ring.material as THREE.MeshBasicMaterial
    ringMat.color.setHex(HAIR_COLOR)
    ringMat.opacity = 0.7

    this.effectGroup.add(this.flagFloor)
  }

  private createSparkles(zone: Zone): void {
    const positions = new Float32Array(SPARKLE_COUNT * 3)
    this.sparkleData = []

    for (let i = 0; i < SPARKLE_COUNT; i++) {
      // Random positions within hex zone bounds
      const angle = Math.random() * Math.PI * 2
      const r = Math.random() * SPARKLE_SPREAD
      const baseY = 0.1 + Math.random() * SPARKLE_HEIGHT

      positions[i * 3] = Math.cos(angle) * r
      positions[i * 3 + 1] = baseY
      positions[i * 3 + 2] = Math.sin(angle) * r

      this.sparkleData.push({
        baseY,
        phase: Math.random() * Math.PI * 2,
        speed: 2 + Math.random() * 3,
      })
    }

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const mat = new THREE.PointsMaterial({
      color: 0xffd700, // Gold sparkles
      size: 0.06,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    this.sparkles = new THREE.Points(geom, mat)
    this.effectGroup.add(this.sparkles)
  }

  private update = (delta: number): void => {
    if (!this.active) return
    this.time += delta

    // Animate hair glow
    if (this.overlay) {
      const hairMat = this.overlay.hairMesh.material as THREE.MeshStandardMaterial
      hairMat.emissiveIntensity = 0.15 + Math.sin(this.time * 3) * 0.1
    }

    // Animate sparkles - twinkle on/off
    if (this.sparkles) {
      const positions = this.sparkles.geometry.attributes.position as THREE.BufferAttribute
      const posArray = positions.array as Float32Array

      for (let i = 0; i < SPARKLE_COUNT; i++) {
        const s = this.sparkleData[i]
        // Gentle float
        posArray[i * 3 + 1] = s.baseY + Math.sin(this.time * s.speed + s.phase) * 0.1
      }
      positions.needsUpdate = true

      // Overall sparkle opacity pulse
      const mat = this.sparkles.material as THREE.PointsMaterial
      mat.opacity = 0.5 + Math.sin(this.time * 4) * 0.3
    }

    // Animate flag stripes (subtle wave)
    if (this.flagFloor) {
      this.flagFloor.children.forEach((child, i) => {
        if (child instanceof THREE.Mesh && i < 5) { // Stripes only
          const mat = child.material as THREE.MeshBasicMaterial
          mat.opacity = 0.4 + Math.sin(this.time * 2 + i * 0.5) * 0.2
        }
      })
    }
  }

  private cleanup(): void {
    // Remove Trump overlay from character
    if (this.overlay && this.claude) {
      this.claude.mesh.remove(this.overlay.hairMesh)
      this.claude.mesh.remove(this.overlay.tieMesh)
      for (const panel of this.overlay.suitOverlay) {
        this.claude.mesh.remove(panel)
      }

      // Dispose overlay geometries/materials
      this.overlay.hairMesh.geometry.dispose()
      ;(this.overlay.hairMesh.material as THREE.Material).dispose()
      this.overlay.tieMesh.geometry.dispose()
      ;(this.overlay.tieMesh.material as THREE.Material).dispose()
      for (const panel of this.overlay.suitOverlay) {
        panel.geometry.dispose()
        ;(panel.material as THREE.Material).dispose()
      }
      this.overlay = null
    }

    // Restore zone floor
    if (this.zoneId) {
      const zone = this.scene.getZone(this.zoneId)
      if (zone) {
        const floorMat = zone.floor.material as THREE.MeshStandardMaterial
        floorMat.color.setHex(this.originalFloorColor)
        floorMat.emissive.setHex(this.originalFloorEmissive)
        floorMat.emissiveIntensity = this.originalFloorIntensity

        const ringMat = zone.ring.material as THREE.MeshBasicMaterial
        ringMat.color.setHex(zone.color)
        ringMat.opacity = 0.4
      }
    }

    // Remove flag floor
    if (this.flagFloor) {
      this.effectGroup.remove(this.flagFloor)
      this.flagFloor.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          if (child.material instanceof THREE.Material) child.material.dispose()
        }
      })
      this.flagFloor = null
    }

    // Remove sparkles
    if (this.sparkles) {
      this.effectGroup.remove(this.sparkles)
      this.sparkles.geometry.dispose()
      ;(this.sparkles.material as THREE.Material).dispose()
      this.sparkles = null
    }
    this.sparkleData = []

    // Remove from parent
    if (this.effectGroup.parent) {
      this.effectGroup.parent.remove(this.effectGroup)
    }
  }

  isActive(): boolean {
    return this.active
  }

  dispose(): void {
    this.deactivate()
  }
}
