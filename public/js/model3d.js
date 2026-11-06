// 3D model preview: STL and 3MF with three.js's loaders, STEP converted into triangles by OpenCascade
// (occt-import-js) in a worker. Loaded only when a model is opened: three.js is heavy.
//
// The notes' points are x, y, z in 0..1 inside the box containing the model: they do not depend on the file's
// units and the server checks them like page coordinates.
import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { STLLoader } from '../vendor/three/addons/STLLoader.js';
import { ThreeMFLoader } from '../vendor/three/addons/3MFLoader.js';
import { tr } from './i18n.js';

export const MODEL_EXT = /\.(stl|3mf|stp|step)$/i;

const material = color => new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });
const GREY = 0x9aa4b0;
const ISO = () => new THREE.Vector3(1, -1.4, 0.9); // initial view: front, right, from above

function readStep(buffer) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./step-worker.js', import.meta.url));
    w.onmessage = ev => { w.terminate(); ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data.meshes); };
    w.onerror = ev => { w.terminate(); reject(new Error(ev.message || tr('conversion failed'))); };
    w.postMessage(buffer, [buffer]);
  });
}

// File → three.js object. onStatus gets the messages to show during long conversions.
export async function parseModel(buffer, name, onStatus) {
  const ext = name.match(MODEL_EXT)?.[1].toLowerCase();
  if (ext === 'stl') {
    const geo = new STLLoader().parse(buffer);
    const mat = material(GREY);
    if (geo.hasColors) { mat.vertexColors = true; mat.color.set(0xffffff); }
    return new THREE.Mesh(geo, mat);
  }
  if (ext === '3mf') {
    const group = new ThreeMFLoader().parse(buffer);
    group.traverse(o => { if (o.material) for (const m of [o.material].flat()) m.side = THREE.DoubleSide; });
    return group;
  }
  onStatus?.(tr('Converting the STEP into triangles… (this may take a while)'));
  const group = new THREE.Group();
  for (const m of await readStep(buffer)) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    if (m.normal) geo.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
    geo.setIndex(new THREE.BufferAttribute(m.index, 1));
    if (!m.normal) geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, material(m.color ? new THREE.Color(...m.color) : GREY)));
  }
  return group;
}

// Scene with the model in the centre: rotate (left), pan (right), zoom (wheel or pinch).
// Redrawn only when the view changes. onView(settled) follows every movement; settled = view at rest.
export function createStage(host, onView) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  camera.up.set(0, 0, 1); // STL, 3MF and STEP almost always have the Z axis up
  scene.add(new THREE.HemisphereLight(0xffffff, 0x707884, 1.4));
  // Light following the camera: the face being looked at is always lit.
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.4, 0.6, 0);
  sun.target.position.set(0, 0, -1);
  camera.add(sun, sun.target);
  scene.add(camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  const ray = new THREE.Raycaster();
  let model = null;
  let box = new THREE.Box3();
  let settleTimer;
  let touched = false; // until the view has been moved, every resize fits the model again

  const draw = () => renderer.render(scene, camera);
  const changed = () => {
    draw();
    onView(false);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => onView(true), 150);
  };
  controls.addEventListener('change', changed);
  controls.addEventListener('start', () => { touched = true; });

  const size = () => box.getSize(new THREE.Vector3());
  const toWorld = p => {
    const s = size();
    return new THREE.Vector3(box.min.x + p.x * s.x, box.min.y + p.y * s.y, box.min.z + (p.z ?? 0.5) * s.z);
  };
  const toUnit = v => {
    const s = size();
    const f = (a, min, len) => (len > 1e-9 ? Math.min(1, Math.max(0, (a - min) / len)) : 0.5);
    return { x: f(v.x, box.min.x, s.x), y: f(v.y, box.min.y, s.y), z: f(v.z, box.min.z, s.z) };
  };
  const radius = () => Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-6);

  // Distance at which the model fits the box, in height and in width.
  function aim(dir) {
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const fov = Math.min(vfov, 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect));
    const dist = radius() / Math.sin(fov / 2) * 1.1;
    camera.near = dist / 200;
    camera.far = dist * 50;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    camera.position.copy(dir.normalize().multiplyScalar(dist));
    controls.update();
    changed();
  }

  // Ray from the screen: the surface hit, or null outside the model.
  function hit(clientX, clientY) {
    if (!model) return null;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
    return ray.intersectObject(model, true)[0] || null;
  }

  return {
    setModel(obj) {
      model = obj;
      // Centred on the origin: rotation and light turn around the model.
      box.setFromObject(obj);
      obj.position.sub(box.getCenter(new THREE.Vector3()));
      obj.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(obj);
      scene.add(obj);
      this.resize();
      this.reset();
    },
    reset() {
      touched = false;
      aim(ISO());
    },
    resize() {
      const w = host.clientWidth;
      const hgt = host.clientHeight;
      if (!w || !hgt) return;
      renderer.setSize(w, hgt);
      camera.aspect = w / hgt;
      camera.updateProjectionMatrix();
      if (model && !touched) aim(ISO());
      else changed();
    },
    pick(clientX, clientY) {
      const i = hit(clientX, clientY);
      return i && toUnit(i.point);
    },
    // Screen position (px inside host) of a saved point; behind = behind the camera.
    toScreen(p) {
      const v = toWorld(p).project(camera);
      return { left: ((v.x + 1) / 2) * host.clientWidth, top: ((1 - v.y) / 2) * host.clientHeight, behind: v.z > 1 };
    },
    // Is the point hidden by another part of the model? (one ray per point: asked when the view is at rest)
    hidden(p) {
      if (!model) return false;
      const target = toWorld(p);
      const dist = camera.position.distanceTo(target);
      ray.set(camera.position, target.clone().sub(camera.position).normalize());
      const first = ray.intersectObject(model, true)[0];
      return !!first && first.distance < dist - radius() * 0.01;
    },
    // Turn the view to look at the point from its side, at the same distance.
    focus(p) {
      touched = true;
      const dir = toWorld(p);
      if (dir.lengthSq() > 1e-12) aim(dir.add(new THREE.Vector3(0, 0, radius() * 0.3)));
    },
    dispose() {
      clearTimeout(settleTimer);
      controls.dispose();
      model?.traverse(o => {
        o.geometry?.dispose();
        for (const m of [o.material].flat().filter(Boolean)) m.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
