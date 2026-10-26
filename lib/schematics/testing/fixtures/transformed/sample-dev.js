// samples/sample.transformed.ts
import tgpu, { d } from "typegpu";
var helper = /* @__PURE__ */ (($) => (globalThis.__TYPEGPU_META__ ??= /* @__PURE__ */ new WeakMap()).set($.f = function helper2(x) {
  "use gpu";
  return __tsover_mul(x, 2);
}, {
  v: 2,
  name: "helper",
  ast: {
    params: [{
      type: "i",
      name: "x"
    }],
    body: [0, [[10, [1, "x", "*", [5, "2"]]]]]
  },
  externals: {}
}) && $.f)({});
function sceneFragment(time) {
  return tgpu.fragmentFn({
    in: {
      uv: d.vec2f
    },
    out: d.vec4f
  })(/* @__PURE__ */ (($) => (globalThis.__TYPEGPU_META__ ??= /* @__PURE__ */ new WeakMap()).set($.f = (input) => {
    "use gpu";
    const wave = __tsover_add(0.5, __tsover_mul(0.5, Math.sin(__tsover_add(__tsover_mul(input.uv.x, 6), __tsover_mul(time.$, 2)))));
    return d.vec4f(wave, 0, 0, 1);
  }, {
    v: 2,
    name: void 0,
    ast: {
      params: [{
        type: "i",
        name: "input"
      }],
      body: [0, [[13, "wave", [1, [5, "0.5"], "+", [1, [5, "0.5"], "*", [6, "Math.sin", [[1, [1, [7, [7, "input", "uv"], "x"], "*", [5, "6"]], "+", [1, [7, "time", "$"], "*", [5, "2"]]]]]]]], [10, [6, "d.vec4f", ["wave", [5, "0"], [5, "0"], [5, "1"]]]]]]
    },
    externals: {
      "Math.sin": () => Math.sin,
      "time": () => time,
      "d.vec4f": () => d.vec4f
    }
  }) && $.f)({}));
}
var arrowHelper = /* @__PURE__ */ (($) => (globalThis.__TYPEGPU_META__ ??= /* @__PURE__ */ new WeakMap()).set($.f = (a, b) => {
  "use gpu";
  return __tsover_add(a, b);
}, {
  v: 2,
  name: "arrowHelper",
  ast: {
    params: [{
      type: "i",
      name: "a"
    }, {
      type: "i",
      name: "b"
    }],
    body: [0, [[10, [1, "a", "+", "b"]]]]
  },
  externals: {}
}) && $.f)({});
var asyncLike = /* @__PURE__ */ (globalThis.__TYPEGPU_AUTONAME__ ?? ((a) => a))(tgpu.fn([d.f32], d.f32)(/* @__PURE__ */ (($) => (globalThis.__TYPEGPU_META__ ??= /* @__PURE__ */ new WeakMap()).set($.f = function named(v) {
  "use gpu";
  return v;
}, {
  v: 2,
  name: "named",
  ast: {
    params: [{
      type: "i",
      name: "v"
    }],
    body: [0, [[10, "v"]]]
  },
  externals: {}
}) && $.f)({})), "asyncLike");
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
