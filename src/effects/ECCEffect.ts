/**
 * ECCEffect - "Shadow Clone" (影分身) effect for Enhanced Claude Code mode
 *
 * Visual:
 * - 3 translucent clones of ClaudeMon positioned in a triangle around the original
 * - Rotating skill aura ring above the character's head
 * - Spiral-rising charge particles
 *
 * Performance: Uses shared geometries, limits particle count, reuses materials
 */

import * as THREE from 'three'
import type { WorkshopScene, Zone } from '../scene/WorkshopScene'
import type { Claude } from '../entities/ClaudeMon'

// Clone positioning: triangle around the original, radius ~0.8
const CLONE_COUNT = 3
const CLONE_RADIUS = 0.8
const CLONE_OPACITY = 0.35
const CLONE_SCALE = 0.85 // Slightly smaller than original

// Aura ring
const AURA_RING_INNER = 0.4
const AURA_RING_OUTER = 0.5
const AURA_RING_Y = 1.0 // Above head
const AURA_ROTATION_SPEED = 1.5 // radians/sec

// Rune symbols on aura (simple geometry shapes)
const RUNE_COUNT = 6
const RUNE_RADIUS = 0.45

// Spiral particles
const PARTICLE_COUNT = 40
const SPIRAL_RADIUS_MIN = 0.3
const SPIRAL_RADIUS_MAX = 0.8
const SPIRAL_HEIGHT = 1.5
const SPIRAL_SPEED = 2.0

interface CloneData {
  mesh: THREE.Group
  angleOffset: number
}

interface ParticleData {
  phase: number   // 0-1 position along spiral
  speed: number   // phase increment per second
  radius: number  // distance from center
}

export class ECCEffect {
  private scene: WorkshopScene
  private active = false
  private clones: CloneData[] = []
  private auraGroup: THREE.Group | null = null
  private particleSystem: THREE.Points | null = null
  private particleData: ParticleData[] = []
  private effectGroup: THREE.Group  // Parent group attached to zone
  private time = 0
  private zoneId: string | null = null

  // Shared materials
  private static cloneMaterial: THREE.MeshStandardMaterial | null = null
  private static particleMaterial: THREE.PointsMaterial | null = null

  constructor(scene: WorkshopScene) {
    this.scene = scene
    this.effectGroup = new THREE.Group()
    this.effectGroup.name = 'ecc-effect'
  }

  activate(zoneId: string, claude: Claude): void {
    if (this.active) this.deactivate()

    this.active = true
    this.zoneId = zoneId
    this.time = 0

    const zone = this.scene.getZone(zoneId)
    if (!zone) return

    // Attach effect group to zone
    zone.group.add(this.effectGroup)

    // Create clones around the character
    this.createClones(claude, zone)

    // Create aura ring
    this.createAuraRing()

    // Create spiral particles
    this.createSpiralParticles()

    // Start render loop
    this.scene.onRender(this.update)
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false

    // Fade out then cleanup
    this.cleanup()

    this.scene.offRender(this.update)
    this.zoneId = null
  }

  private createClones(claude: Claude, zone: Zone): void {
    // Get local position of the character within the zone
    const charWorldPos = claude.mesh.position.clone()
    const zoneWorldPos = zone.group.position.clone()
    const localPos = charWorldPos.sub(zoneWorldPos)

    for (let i = 0; i < CLONE_COUNT; i++) {
      const angle = (Math.PI * 2 / CLONE_COUNT) * i
      const cloneMesh = this.createGhostClone(claude)

      // Position in triangle around character's local position
      cloneMesh.position.set(
        localPos.x + Math.cos(angle) * CLONE_RADIUS,
        localPos.y,
        localPos.z + Math.sin(angle) * CLONE_RADIUS
      )
      cloneMesh.scale.setScalar(CLONE_SCALE * claude.mesh.scale.x)

      // Face toward center
      cloneMesh.lookAt(new THREE.Vector3(localPos.x, cloneMesh.position.y, localPos.z))

      this.effectGroup.add(cloneMesh)
      this.clones.push({ mesh: cloneMesh, angleOffset: angle })
    }
  }

  /**
   * Create a ghost/translucent copy of the character mesh
   * Uses a simple silhouette approach rather than deep cloning
   */
  private createGhostClone(claude: Claude): THREE.Group {
    const ghost = new THREE.Group()

    if (!ECCEffect.cloneMaterial) {
      ECCEffect.cloneMaterial = new THREE.MeshStandardMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: CLONE_OPACITY,
        emissive: 0x67e8f9,
        emissiveIntensity: 0.3,
        roughness: 0.8,
        metalness: 0.2,
        depthWrite: false,
      })
    }

    // Clone the mesh structure but apply ghost material
    claude.mesh.traverse(child => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const ghostMesh = new THREE.Mesh(child.geometry, ECCEffect.cloneMaterial!)
        // Copy transform relative to claude.mesh
        ghostMesh.position.copy(child.position)
        ghostMesh.rotation.copy(child.rotation)
        ghostMesh.scale.copy(child.scale)

        // Walk up to get the full local transform chain
        let parent = child.parent
        while (parent && parent !== claude.mesh) {
          ghostMesh.position.add(parent.position)
          // Apply parent rotation (simplified - just add for nested groups)
          parent = parent.parent
        }

        ghost.add(ghostMesh)
      }
    })

    return ghost
  }

  private createAuraRing(): void {
    this.auraGroup = new THREE.Group()
    this.auraGroup.position.y = AURA_RING_Y

    // Main ring
    const ringGeom = new THREE.RingGeometry(AURA_RING_INNER, AURA_RING_OUTER, 32)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xa78bfa, // Purple
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const ring = new THREE.Mesh(ringGeom, ringMat)
    ring.rotation.x = -Math.PI / 2
    this.auraGroup.add(ring)

    // Rune symbols (simple diamond shapes around the ring)
    const runeGeom = new THREE.PlaneGeometry(0.08, 0.08)
    const runeMat = new THREE.MeshBasicMaterial({
      color: 0xc4b5fd,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    })

    for (let i = 0; i < RUNE_COUNT; i++) {
      const angle = (Math.PI * 2 / RUNE_COUNT) * i
      const rune = new THREE.Mesh(runeGeom, runeMat.clone())
      rune.position.set(
        Math.cos(angle) * RUNE_RADIUS,
        0,
        Math.sin(angle) * RUNE_RADIUS
      )
      rune.rotation.x = -Math.PI / 2
      rune.rotation.z = Math.PI / 4 // Diamond shape
      this.auraGroup.add(rune)
    }

    this.effectGroup.add(this.auraGroup)
  }

  private createSpiralParticles(): void {
    const positions = new Float32Array(PARTICLE_COUNT * 3)
    const colors = new Float32Array(PARTICLE_COUNT * 3)

    this.particleData = []
    const color = new THREE.Color(0x67e8f9)

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Initialize random positions along the spiral
      const phase = Math.random()
      const speed = SPIRAL_SPEED * (0.5 + Math.random() * 0.5)
      const radius = SPIRAL_RADIUS_MIN + Math.random() * (SPIRAL_RADIUS_MAX - SPIRAL_RADIUS_MIN)

      this.particleData.push({ phase, speed, radius })

      // Set initial position
      const angle = phase * Math.PI * 4 // Two full rotations
      const y = phase * SPIRAL_HEIGHT
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = Math.sin(angle) * radius

      // Cyan to purple gradient based on height
      const t = phase
      colors[i * 3] = color.r * (1 - t) + 0.65 * t
      colors[i * 3 + 1] = color.g * (1 - t) + 0.47 * t
      colors[i * 3 + 2] = color.b * (1 - t) + 0.98 * t
    }

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    if (!ECCEffect.particleMaterial) {
      ECCEffect.particleMaterial = new THREE.PointsMaterial({
        size: 0.04,
        vertexColors: true,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    }

    this.particleSystem = new THREE.Points(geom, ECCEffect.particleMaterial)
    this.effectGroup.add(this.particleSystem)
  }

  private update = (delta: number): void => {
    if (!this.active) return
    this.time += delta

    // Animate clones: gentle floating bob + subtle breathing
    for (const clone of this.clones) {
      const bobOffset = Math.sin(this.time * 2 + clone.angleOffset) * 0.05
      clone.mesh.position.y = 0.22 + bobOffset // Base y from ClaudeMon

      // Subtle opacity pulse
      clone.mesh.traverse(child => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial
          if (mat.transparent) {
            mat.opacity = CLONE_OPACITY + Math.sin(this.time * 3 + clone.angleOffset * 2) * 0.08
          }
        }
      })
    }

    // Rotate aura ring
    if (this.auraGroup) {
      this.auraGroup.rotation.y += delta * AURA_ROTATION_SPEED

      // Pulse rune opacity
      this.auraGroup.children.forEach((child, i) => {
        if (i > 0 && child instanceof THREE.Mesh) { // Skip the ring itself
          const mat = child.material as THREE.MeshBasicMaterial
          mat.opacity = 0.4 + Math.sin(this.time * 4 + i * 1.2) * 0.3
        }
      })
    }

    // Animate spiral particles
    if (this.particleSystem) {
      const positions = this.particleSystem.geometry.attributes.position as THREE.BufferAttribute
      const posArray = positions.array as Float32Array

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = this.particleData[i]
        p.phase = (p.phase + delta * p.speed * 0.3) % 1.0

        const angle = p.phase * Math.PI * 4
        const y = p.phase * SPIRAL_HEIGHT
        posArray[i * 3] = Math.cos(angle) * p.radius
        posArray[i * 3 + 1] = y
        posArray[i * 3 + 2] = Math.sin(angle) * p.radius
      }

      positions.needsUpdate = true
    }
  }

  private cleanup(): void {
    // Remove clones
    for (const clone of this.clones) {
      this.effectGroup.remove(clone.mesh)
      clone.mesh.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          // Don't dispose shared material
        }
      })
    }
    this.clones = []

    // Remove aura
    if (this.auraGroup) {
      this.effectGroup.remove(this.auraGroup)
      this.auraGroup.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          if (child.material instanceof THREE.Material) child.material.dispose()
        }
      })
      this.auraGroup = null
    }

    // Remove particles
    if (this.particleSystem) {
      this.effectGroup.remove(this.particleSystem)
      this.particleSystem.geometry.dispose()
      // Don't dispose shared material
      this.particleSystem = null
    }
    this.particleData = []

    // Remove effect group from zone
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
