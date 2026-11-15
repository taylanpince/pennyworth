import { Box3, Color, DirectionalLight, HemisphereLight, LoadingManager, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Sphere, Vector3, WebGLRenderer } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** Called only after checkCadModel has accepted the attachment. No remote resources or decoders. */
export async function renderCad(host: HTMLDivElement, bytes: ArrayBuffer, name: string) {
  const manager = new LoadingManager();
  manager.setURLModifier(() => { throw new Error("External model resources are not supported."); });
  const model = (await new GLTFLoader(manager).parseAsync(bytes, "")).scene;
  // CAD exports often omit PBR properties (glTF defaults to metal). A matte preview makes the
  // geometry legible without downloading an HDR environment; exported files remain unchanged.
  model.traverse((object) => {
    if (object instanceof Mesh) {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof MeshStandardMaterial) {
          material.metalness = 0;
          material.roughness = 0.7;
        }
      }
    }
  });
  const releaseModel = () => model.traverse((object) => {
    if (object instanceof Mesh) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    }
  });
  const bounds = new Box3().setFromObject(model);
  const sphere = bounds.getBoundingSphere(new Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    releaseModel();
    throw new Error("The model contains no viewable geometry.");
  }
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  } catch {
    releaseModel();
    throw new Error("3D rendering is unavailable in this browser. You can still download the model.");
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.setAttribute("aria-label", `${name}: drag to rotate, scroll or pinch to zoom`);
  renderer.domElement.tabIndex = 0;
  const scene = new Scene();
  scene.background = new Color(0xe9eff2);
  scene.add(model, new HemisphereLight(0xffffff, 0x607080, 3));
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const camera = new PerspectiveCamera(40, 1, sphere.radius / 100, sphere.radius * 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(sphere.center);
  controls.minDistance = sphere.radius * 0.3;
  controls.maxDistance = sphere.radius * 20;
  controls.listenToKeyEvents(renderer.domElement);
  const draw = () => renderer.render(scene, camera);
  const reset = () => {
    const angle = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
    const distance = sphere.radius / Math.sin(angle) * 1.15;
    camera.position.copy(sphere.center).add(new Vector3(1, 0.9, 1.3).normalize().multiplyScalar(distance));
    controls.target.copy(sphere.center);
    controls.update();
    draw();
  };
  controls.addEventListener("change", draw);
  host.append(renderer.domElement);
  const resize = new ResizeObserver(() => {
    const width = Math.max(1, host.clientWidth);
    renderer.setSize(width, 320, false);
    camera.aspect = width / 320;
    camera.updateProjectionMatrix();
    reset();
  });
  resize.observe(host);
  reset();
  return {
    reset,
    dispose() {
      resize.disconnect();
      controls.dispose();
      releaseModel();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
    saveImage() {
      draw();
      renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = name.replace(/\.glb$/i, "") + ".png";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    },
  };
}
