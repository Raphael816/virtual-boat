/**
 * 高画質設定のポストプロセス：HDR描画 → カメラのモーションブラー → 被写界深度 → トーンマッピング。
 *
 * - モーションブラー：深度と前フレームのカメラ行列から画面上の動きを求めてぼかす。
 *   カメラが追っている馬にまでぶれが乗らないよう、馬のレイヤーだけを描いたマスクで除外する
 *   （流し撮りのように、背景だけが流れる）
 * - 被写界深度：ピント位置（追っている馬）からの距離に応じてぼかす。望遠らしい浅い被写界深度
 * - 派手な発光（ブルーム）は使わない
 */
import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

interface Shared {
  sceneDepth: THREE.DepthTexture | null;
}

class MotionBlurPass extends Pass {
  readonly material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  constructor(
    private shared: Shared,
    mask: THREE.Texture,
  ) {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tMask: { value: mask },
        uInvVP: { value: new THREE.Matrix4() },
        uPrevVP: { value: new THREE.Matrix4() },
        uStrength: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor; uniform sampler2D tDepth; uniform sampler2D tMask;
        uniform mat4 uInvVP; uniform mat4 uPrevVP; uniform float uStrength; varying vec2 vUv;
        void main(){
          float d = texture2D(tDepth, vUv).x;
          vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 world = uInvVP * clip; world /= world.w;
          vec4 prev = uPrevVP * world;
          vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
          vec2 vel = (vUv - prevUv) * uStrength;
          vel *= 1.0 - texture2D(tMask, vUv).r;
          float len = length(vel);
          if (len > 0.02) vel *= 0.02 / len;
          vec4 c = texture2D(tColor, vUv);
          float w = 1.0;
          for (int i = 0; i < 8; i++) {
            float t = (float(i) + 0.5) / 8.0 - 0.5;
            vec2 uv = vUv + vel * t;
            float ww = 1.0 - texture2D(tMask, uv).r;
            c += texture2D(tColor, uv) * ww;
            w += ww;
          }
          gl_FragColor = c / w;
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.shared.sceneDepth = readBuffer.depthTexture;
    this.material.uniforms.tColor.value = readBuffer.texture;
    this.material.uniforms.tDepth.value = readBuffer.depthTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

class DofPass extends Pass {
  readonly material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  constructor(private shared: Shared) {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uFocus: { value: 50 },
        uAperture: { value: 0.0045 },
        uMaxBlur: { value: 0.0035 },
        uNear: { value: 1 },
        uFar: { value: 6000 },
        uAspect: { value: 16 / 9 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tColor; uniform sampler2D tDepth;
        uniform float uFocus; uniform float uAperture; uniform float uMaxBlur; uniform float uNear; uniform float uFar; uniform float uAspect;
        varying vec2 vUv;
        float cocAt(vec2 uv){
          float d = texture2D(tDepth, uv).x;
          float dist = -perspectiveDepthToViewZ(d, uNear, uFar);
          return clamp(abs(dist - uFocus) / max(dist, 0.1) * uAperture, 0.0, uMaxBlur);
        }
        void main(){
          float coc = cocAt(vUv);
          vec4 c = texture2D(tColor, vUv);
          if (coc < 0.0004) { gl_FragColor = c; return; }
          float w = 1.0;
          for (int i = 1; i < 16; i++) {
            float fi = float(i);
            float r = sqrt(fi / 16.0) * coc;
            float a = fi * 2.39996;
            vec2 uv = vUv + vec2(cos(a) / uAspect, sin(a)) * r;
            // 手前のピントが合った物の上に、奥のぼけがにじまないようにする
            float sc = cocAt(uv);
            float ww = smoothstep(0.0, coc, sc + 0.0002);
            c += texture2D(tColor, uv) * ww;
            w += ww;
          }
          gl_FragColor = c / w;
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.material.uniforms.tColor.value = readBuffer.texture;
    this.material.uniforms.tDepth.value = this.shared.sceneDepth;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

export class PostFX {
  private sceneRT: THREE.WebGLRenderTarget;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private shared: Shared = { sceneDepth: null };
  private mb: MotionBlurPass;
  private dof: DofPass;
  private output = new OutputPass();
  private maskRT: THREE.WebGLRenderTarget;
  private maskMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  private prevVP = new THREE.Matrix4();
  private hasPrev = false;
  private black = new THREE.Color(0, 0, 0);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ) {
    // シーンは専用のターゲット（深度テクスチャつき）に描き、後段は深度なしの2枚で受け渡す
    // （同じ深度テクスチャを読み書きしないため）
    const pr = renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * pr));
    const h = Math.max(1, Math.floor(height * pr));
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(w, h) });
    this.rtA = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    this.maskRT = new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.mb = new MotionBlurPass(this.shared, this.maskRT.texture);
    this.dof = new DofPass(this.shared);
    this.output.renderToScreen = true;
    this.dof.material.uniforms.uAspect.value = width / Math.max(1, height);
  }

  setSize(width: number, height: number) {
    const pr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * pr));
    const h = Math.max(1, Math.floor(height * pr));
    this.sceneRT.setSize(w, h);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.maskRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.dof.material.uniforms.uAspect.value = width / Math.max(1, height);
  }

  /** カットでカメラが飛んだときは、前フレームとのぶれを付けない */
  resetHistory() {
    this.hasPrev = false;
  }

  render(dt: number, focusDistance: number) {
    const r = this.renderer;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    // 1) シーン（HDR・リニア）
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, cam);

    // 2) 馬だけのマスク（レイヤー1）
    const bg = this.scene.background;
    const fog = this.scene.fog;
    const prevMask = cam.layers.mask;
    this.scene.background = this.black;
    this.scene.fog = null;
    this.scene.overrideMaterial = this.maskMat;
    cam.layers.set(1);
    r.setRenderTarget(this.maskRT);
    r.setClearColor(this.black, 1);
    r.clear();
    r.render(this.scene, cam);
    cam.layers.mask = prevMask;
    this.scene.overrideMaterial = null;
    this.scene.background = bg;
    this.scene.fog = fog;

    // 3) モーションブラー → 4) 被写界深度 → 5) トーンマッピングして画面へ
    const u = this.mb.material.uniforms;
    u.uInvVP.value.copy(vp).invert();
    u.uPrevVP.value.copy(this.hasPrev ? this.prevVP : vp);
    u.uStrength.value = dt > 0 ? Math.min(1.0, 0.008 / dt) : 0;
    this.prevVP.copy(vp);
    this.hasPrev = true;
    this.mb.render(r, this.rtA, this.sceneRT);
    const d = this.dof.material.uniforms;
    d.uFocus.value = focusDistance;
    d.uNear.value = cam.near;
    d.uFar.value = cam.far;
    this.dof.render(r, this.rtB, this.rtA);
    this.output.render(r, null as unknown as THREE.WebGLRenderTarget, this.rtB, dt, false);
    r.setRenderTarget(null);
  }

  dispose() {
    this.mb.dispose();
    this.dof.dispose();
    this.output.dispose();
    this.sceneRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.maskRT.dispose();
    this.maskMat.dispose();
  }
}
