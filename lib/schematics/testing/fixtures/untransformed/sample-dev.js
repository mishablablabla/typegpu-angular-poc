// samples/sample.gpu.ts
import tgpu, { d } from "typegpu";
function sceneFragment(time) {
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    "use gpu";
    const wave = 0.5 + 0.5 * Math.sin(input.uv.x * 6 + time.$ * 2);
    return d.vec4f(wave, 0, 0, 1);
  });
}
function helper(x) {
  "use gpu";
  return x * 2;
}
var arrowHelper = (a, b) => {
  "use gpu";
  return a + b;
};
var asyncLike = tgpu.fn([d.f32], d.f32)(function named(v) {
  "use gpu";
  return v;
});
var note = "Use 'use gpu'; in your shader functions";
var tpl = `function f() { 'use gpu'; return 1; }`;
export {
  arrowHelper,
  asyncLike,
  helper,
  note,
  sceneFragment,
  tpl
};
