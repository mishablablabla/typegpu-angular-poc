import { tgpu, d as d$1, std } from 'typegpu';
import { sqrt, cos, sin, normalize, dot, sign, select, step, tan, log, floor, fract, allEq, mix } from 'typegpu/std';
import * as d from 'typegpu/data';

let quinticDerivative = (/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (function quinticDerivative(t) {
  "use gpu";
  return __tsover_mul(__tsover_mul(__tsover_mul(30, t), t), __tsover_add(__tsover_mul(t, __tsover_sub(t, 2)), 1));
}), {
    v: 2,
    name: "quinticDerivative",
    ast: {"params":[{"type":"i","name":"t"}],"body":[0,[[10,[1,[1,[1,[5,"30"],"*","t"],"*","t"],"*",[1,[1,"t","*",[1,"t","-",[5,"2"]]],"+",[5,"1"]]]]]]},
    externals: {}
  }) && $.f)({}));

let quinticInterpolation = (/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (function quinticInterpolation(t) {
  "use gpu";
  return __tsover_mul(__tsover_mul(__tsover_mul(t, t), t), __tsover_add(__tsover_mul(t, __tsover_sub(__tsover_mul(t, 6), 15)), 10));
}), {
    v: 2,
    name: "quinticInterpolation",
    ast: {"params":[{"type":"i","name":"t"}],"body":[0,[[10,[1,[1,[1,"t","*","t"],"*","t"],"*",[1,[1,"t","*",[1,[1,"t","*",[5,"6"]],"-",[5,"15"]]],"+",[5,"10"]]]]]]},
    externals: {}
  }) && $.f)({}));


const rotl = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.u32, d$1.u32],
  d$1.u32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((x, k) => {
  return x << k | x >>> 32 - k;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"x"},{"type":"i","name":"k"}],"body":[0,[[10,[1,[1,"x","<<","k"],"|",[1,"x",">>>",[1,[5,"32"],"-","k"]]]]]]},
    externals: {}
  }) && $.f)({}))), "rotl"));
const u32To01F32 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.u32],
  d$1.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
  const mantissa = value & 8388607;
  const bits = 1065353216 | mantissa;
  const f = std.bitcast(d$1.u32, d$1.f32)(bits);
  return f - 1;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"mantissa",[1,"value","&",[5,"8388607"]]],[13,"bits",[1,[5,"1065353216"],"|","mantissa"]],[13,"f",[6,[6,"std.bitcast",["d.u32","d.f32"]],["bits"]]],[10,[1,"f","-",[5,"1"]]]]]},
    externals: {"std.bitcast":() => std.bitcast,"d.u32":() => d$1.u32,"d.f32":() => d$1.f32}
  }) && $.f)({}))), "u32To01F32"));
const hash = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.u32],
  d$1.u32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
  if (std.isBeingTranspiled()) {
    let x = value ^ value >>> 17;
    x *= d$1.u32(3982152891);
    x ^= x >>> 11;
    x *= d$1.u32(2890668881);
    x ^= x >>> 15;
    x *= d$1.u32(830770091);
    x ^= x >>> 14;
    return x;
  } else {
    let x = value ^ value >>> 17;
    x = Math.imul(x, 3982152891);
    x = x ^ x >>> 11;
    x = Math.imul(x, 2890668881);
    x = x ^ x >>> 15;
    x = Math.imul(x, 830770091);
    x = x ^ x >>> 14;
    return x;
  }
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[11,[6,"std.isBeingTranspiled",[]],[0,[[12,"x",[1,"value","^",[1,"value",">>>",[5,"17"]]]],[2,"x","*=",[6,"d.u32",[[5,"3982152891"]]]],[2,"x","^=",[1,"x",">>>",[5,"11"]]],[2,"x","*=",[6,"d.u32",[[5,"2890668881"]]]],[2,"x","^=",[1,"x",">>>",[5,"15"]]],[2,"x","*=",[6,"d.u32",[[5,"830770091"]]]],[2,"x","^=",[1,"x",">>>",[5,"14"]]],[10,"x"]]],[0,[[12,"x",[1,"value","^",[1,"value",">>>",[5,"17"]]]],[2,"x","=",[6,"Math.imul",["x",[5,"3982152891"]]]],[2,"x","=",[1,"x","^",[1,"x",">>>",[5,"11"]]]],[2,"x","=",[6,"Math.imul",["x",[5,"2890668881"]]]],[2,"x","=",[1,"x","^",[1,"x",">>>",[5,"15"]]]],[2,"x","=",[6,"Math.imul",["x",[5,"830770091"]]]],[2,"x","=",[1,"x","^",[1,"x",">>>",[5,"14"]]]],[10,"x"]]]]]]},
    externals: {"std.isBeingTranspiled":() => std.isBeingTranspiled,"d.u32":() => d$1.u32,"Math.imul":() => Math.imul}
  }) && $.f)({}))), "hash"));
const seedSaltX = 1253408251 >>> 0;
const seedSaltY = 2900286023 >>> 0;
const seedSaltZ = 3164612939 >>> 0;
const seedSaltW = 3645529909 >>> 0;
const scrambleSeed = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.f32],
  d$1.u32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
  return hash(std.bitcast(d$1.f32, d$1.u32)(value) ^ seedSaltX);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[10,[6,"hash",[[1,[6,[6,"std.bitcast",["d.f32","d.u32"]],["value"]],"^","seedSaltX"]]]]]]},
    externals: {"hash":() => hash,"std.bitcast":() => std.bitcast,"d.f32":() => d$1.f32,"d.u32":() => d$1.u32,"seedSaltX":() => seedSaltX}
  }) && $.f)({}))), "scrambleSeed"));
const scrambleSeed2 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.vec2f],
  d$1.vec2u
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
  const u32Value = std.bitcast(d$1.vec2f, d$1.vec2u)(value);
  return d$1.vec2u(hash(u32Value.x ^ seedSaltX), hash(u32Value.y ^ seedSaltY));
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"u32Value",[6,[6,"std.bitcast",["d.vec2f","d.vec2u"]],["value"]]],[10,[6,"d.vec2u",[[6,"hash",[[1,[7,"u32Value","x"],"^","seedSaltX"]]],[6,"hash",[[1,[7,"u32Value","y"],"^","seedSaltY"]]]]]]]]},
    externals: {"std.bitcast":() => std.bitcast,"d.vec2f":() => d$1.vec2f,"d.vec2u":() => d$1.vec2u,"hash":() => hash,"seedSaltX":() => seedSaltX,"seedSaltY":() => seedSaltY}
  }) && $.f)({}))), "scrambleSeed2"));
const scrambleSeed3 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.vec3f],
  d$1.vec3u
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
  const u32Value = std.bitcast(d$1.vec3f, d$1.vec3u)(value);
  return d$1.vec3u(
    hash(u32Value.x ^ seedSaltX),
    hash(u32Value.y ^ seedSaltY),
    hash(u32Value.z ^ seedSaltZ)
  );
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"u32Value",[6,[6,"std.bitcast",["d.vec3f","d.vec3u"]],["value"]]],[10,[6,"d.vec3u",[[6,"hash",[[1,[7,"u32Value","x"],"^","seedSaltX"]]],[6,"hash",[[1,[7,"u32Value","y"],"^","seedSaltY"]]],[6,"hash",[[1,[7,"u32Value","z"],"^","seedSaltZ"]]]]]]]]},
    externals: {"std.bitcast":() => std.bitcast,"d.vec3f":() => d$1.vec3f,"d.vec3u":() => d$1.vec3u,"hash":() => hash,"seedSaltX":() => seedSaltX,"seedSaltY":() => seedSaltY,"seedSaltZ":() => seedSaltZ}
  }) && $.f)({}))), "scrambleSeed3"));
const scrambleSeed4 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.vec4f],
  d$1.vec4u
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
  const u32Value = std.bitcast(d$1.vec4f, d$1.vec4u)(value);
  return d$1.vec4u(
    hash(u32Value.x ^ seedSaltX),
    hash(u32Value.y ^ seedSaltY),
    hash(u32Value.z ^ seedSaltZ),
    hash(u32Value.w ^ seedSaltW)
  );
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"u32Value",[6,[6,"std.bitcast",["d.vec4f","d.vec4u"]],["value"]]],[10,[6,"d.vec4u",[[6,"hash",[[1,[7,"u32Value","x"],"^","seedSaltX"]]],[6,"hash",[[1,[7,"u32Value","y"],"^","seedSaltY"]]],[6,"hash",[[1,[7,"u32Value","z"],"^","seedSaltZ"]]],[6,"hash",[[1,[7,"u32Value","w"],"^","seedSaltW"]]]]]]]]},
    externals: {"std.bitcast":() => std.bitcast,"d.vec4f":() => d$1.vec4f,"d.vec4u":() => d$1.vec4u,"hash":() => hash,"seedSaltX":() => seedSaltX,"seedSaltY":() => seedSaltY,"seedSaltZ":() => seedSaltZ,"seedSaltW":() => seedSaltW}
  }) && $.f)({}))), "scrambleSeed4"));

const randomGeneratorShell = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([], d$1.f32), "randomGeneratorShell"));
const cpuImplNotAvailable = (prng, fn) => {
  throw new Error(`CPU implementation of ${prng}:${fn} is not available`);
};
const BPETER = (() => {
  const seed = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.privateVar(d$1.vec2f), "seed"));
  return {
    seed: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.f32])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      "use gpu";
      if (!std.isBeingTranspiled()) {
        cpuImplNotAvailable("BPETER", "seed");
      }
      const scrambled = scrambleSeed(value);
      seed.$ = __tsover_sub(__tsover_mul(d$1.vec2f(u32To01F32(hash(scrambled)), u32To01F32(hash(rotl(scrambled, 16)))), 2), 1);
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[11,[4,"!",[6,"std.isBeingTranspiled",[]]],[0,[[6,"cpuImplNotAvailable",[[103,"BPETER"],[103,"seed"]]]]]],[13,"scrambled",[6,"scrambleSeed",["value"]]],[2,[7,"seed","$"],"=",[1,[1,[6,"d.vec2f",[[6,"u32To01F32",[[6,"hash",["scrambled"]]]],[6,"u32To01F32",[[6,"hash",[[6,"rotl",["scrambled",[5,"16"]]]]]]]]],"*",[5,"2"]],"-",[5,"1"]]]]]},
    externals: {"std.isBeingTranspiled":() => std.isBeingTranspiled,"cpuImplNotAvailable":() => cpuImplNotAvailable,"scrambleSeed":() => scrambleSeed,"seed":() => seed,"d.vec2f":() => d$1.vec2f,"u32To01F32":() => u32To01F32,"hash":() => hash,"rotl":() => rotl}
  }) && $.f)({}))), "seed")),
    seed2: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec2f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      "use gpu";
      if (!std.isBeingTranspiled()) {
        cpuImplNotAvailable("BPETER", "seed2");
      }
      const scrambled = scrambleSeed2(value);
      seed.$ = __tsover_sub(__tsover_mul(d$1.vec2f(
        u32To01F32(hash(scrambled.x ^ scrambled.y)),
        u32To01F32(hash(rotl(scrambled.x, 16) ^ scrambled.y))
      ), 2), 1);
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[11,[4,"!",[6,"std.isBeingTranspiled",[]]],[0,[[6,"cpuImplNotAvailable",[[103,"BPETER"],[103,"seed2"]]]]]],[13,"scrambled",[6,"scrambleSeed2",["value"]]],[2,[7,"seed","$"],"=",[1,[1,[6,"d.vec2f",[[6,"u32To01F32",[[6,"hash",[[1,[7,"scrambled","x"],"^",[7,"scrambled","y"]]]]]],[6,"u32To01F32",[[6,"hash",[[1,[6,"rotl",[[7,"scrambled","x"],[5,"16"]]],"^",[7,"scrambled","y"]]]]]]]],"*",[5,"2"]],"-",[5,"1"]]]]]},
    externals: {"std.isBeingTranspiled":() => std.isBeingTranspiled,"cpuImplNotAvailable":() => cpuImplNotAvailable,"scrambleSeed2":() => scrambleSeed2,"seed":() => seed,"d.vec2f":() => d$1.vec2f,"u32To01F32":() => u32To01F32,"hash":() => hash,"rotl":() => rotl}
  }) && $.f)({}))), "seed2")),
    seed3: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec3f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      "use gpu";
      if (!std.isBeingTranspiled()) {
        cpuImplNotAvailable("BPETER", "seed3");
      }
      const scrambled = scrambleSeed3(value);
      seed.$ = __tsover_sub(__tsover_mul(d$1.vec2f(
        u32To01F32(hash(scrambled.x ^ rotl(scrambled.z, 16))),
        u32To01F32(hash(rotl(scrambled.y, 16) ^ scrambled.z))
      ), 2), 1);
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[11,[4,"!",[6,"std.isBeingTranspiled",[]]],[0,[[6,"cpuImplNotAvailable",[[103,"BPETER"],[103,"seed3"]]]]]],[13,"scrambled",[6,"scrambleSeed3",["value"]]],[2,[7,"seed","$"],"=",[1,[1,[6,"d.vec2f",[[6,"u32To01F32",[[6,"hash",[[1,[7,"scrambled","x"],"^",[6,"rotl",[[7,"scrambled","z"],[5,"16"]]]]]]]],[6,"u32To01F32",[[6,"hash",[[1,[6,"rotl",[[7,"scrambled","y"],[5,"16"]]],"^",[7,"scrambled","z"]]]]]]]],"*",[5,"2"]],"-",[5,"1"]]]]]},
    externals: {"std.isBeingTranspiled":() => std.isBeingTranspiled,"cpuImplNotAvailable":() => cpuImplNotAvailable,"scrambleSeed3":() => scrambleSeed3,"seed":() => seed,"d.vec2f":() => d$1.vec2f,"u32To01F32":() => u32To01F32,"hash":() => hash,"rotl":() => rotl}
  }) && $.f)({}))), "seed3")),
    seed4: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec4f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      "use gpu";
      if (!std.isBeingTranspiled()) {
        cpuImplNotAvailable("BPETER", "seed4");
      }
      const scrambled = scrambleSeed4(value);
      seed.$ = __tsover_sub(__tsover_mul(d$1.vec2f(
        u32To01F32(hash(scrambled.x ^ rotl(scrambled.z, 16) ^ rotl(scrambled.w, 8))),
        u32To01F32(hash(rotl(scrambled.y, 16) ^ scrambled.z ^ scrambled.w))
      ), 2), 1);
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[11,[4,"!",[6,"std.isBeingTranspiled",[]]],[0,[[6,"cpuImplNotAvailable",[[103,"BPETER"],[103,"seed4"]]]]]],[13,"scrambled",[6,"scrambleSeed4",["value"]]],[2,[7,"seed","$"],"=",[1,[1,[6,"d.vec2f",[[6,"u32To01F32",[[6,"hash",[[1,[1,[7,"scrambled","x"],"^",[6,"rotl",[[7,"scrambled","z"],[5,"16"]]]],"^",[6,"rotl",[[7,"scrambled","w"],[5,"8"]]]]]]]],[6,"u32To01F32",[[6,"hash",[[1,[1,[6,"rotl",[[7,"scrambled","y"],[5,"16"]]],"^",[7,"scrambled","z"]],"^",[7,"scrambled","w"]]]]]]]],"*",[5,"2"]],"-",[5,"1"]]]]]},
    externals: {"std.isBeingTranspiled":() => std.isBeingTranspiled,"cpuImplNotAvailable":() => cpuImplNotAvailable,"scrambleSeed4":() => scrambleSeed4,"seed":() => seed,"d.vec2f":() => d$1.vec2f,"u32To01F32":() => u32To01F32,"hash":() => hash,"rotl":() => rotl}
  }) && $.f)({}))), "seed4")),
    sample: randomGeneratorShell((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
      "use gpu";
      if (!std.isBeingTranspiled()) {
        cpuImplNotAvailable("BPETER", "sample");
      }
      const a = std.dot(seed.$, d$1.vec2f(23.14077926, 232.61690225));
      const b = std.dot(seed.$, d$1.vec2f(54.47856553, 345.84153136));
      seed.$.x = std.fract(__tsover_mul(std.cos(a), 136.8168));
      seed.$.y = std.fract(__tsover_mul(std.cos(b), 534.7645));
      return seed.$.y;
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[11,[4,"!",[6,"std.isBeingTranspiled",[]]],[0,[[6,"cpuImplNotAvailable",[[103,"BPETER"],[103,"sample"]]]]]],[13,"a",[6,"std.dot",[[7,"seed","$"],[6,"d.vec2f",[[5,"23.14077926"],[5,"232.61690225"]]]]]],[13,"b",[6,"std.dot",[[7,"seed","$"],[6,"d.vec2f",[[5,"54.47856553"],[5,"345.84153136"]]]]]],[2,[7,[7,"seed","$"],"x"],"=",[6,"std.fract",[[1,[6,"std.cos",["a"]],"*",[5,"136.8168"]]]]],[2,[7,[7,"seed","$"],"y"],"=",[6,"std.fract",[[1,[6,"std.cos",["b"]],"*",[5,"534.7645"]]]]],[10,[7,[7,"seed","$"],"y"]]]]},
    externals: {"std.isBeingTranspiled":() => std.isBeingTranspiled,"cpuImplNotAvailable":() => cpuImplNotAvailable,"std.dot":() => std.dot,"seed":() => seed,"d.vec2f":() => d$1.vec2f,"std.fract":() => std.fract,"std.cos":() => std.cos}
  }) && $.f)({}))).$name("sample")
  };
})();
const XOROSHIRO64STARSTAR = (() => {
  const gpuSeed = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.privateVar(d$1.vec2u), "gpuSeed"));
  let cpuSeed = d$1.vec2u();
  function updateCpuSeed(seed) {
    cpuSeed = seed;
  }
  const next = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
    [],
    d$1.u32
  )((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
    if (std.isBeingTranspiled()) {
      const s0 = gpuSeed.$[0];
      let s1 = gpuSeed.$[1];
      s1 ^= s0;
      gpuSeed.$[0] = rotl(s0, 26) ^ s1 ^ s1 << 9;
      gpuSeed.$[1] = rotl(s1, 13);
      return rotl(gpuSeed.$[0] * 2654435771, 5) * 5;
    } else {
      const s0 = cpuSeed[0];
      let s1 = cpuSeed[1];
      s1 ^= s0;
      updateCpuSeed(d$1.vec2u(rotl(s0, 26) ^ s1 ^ s1 << 9, rotl(s1, 13)));
      return Math.imul(rotl(Math.imul(cpuSeed[0], 2654435771), 5), 5);
    }
  }), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[11,[6,"std.isBeingTranspiled",[]],[0,[[13,"s0",[8,[7,"gpuSeed","$"],[5,"0"]]],[12,"s1",[8,[7,"gpuSeed","$"],[5,"1"]]],[2,"s1","^=","s0"],[2,[8,[7,"gpuSeed","$"],[5,"0"]],"=",[1,[1,[6,"rotl",["s0",[5,"26"]]],"^","s1"],"^",[1,"s1","<<",[5,"9"]]]],[2,[8,[7,"gpuSeed","$"],[5,"1"]],"=",[6,"rotl",["s1",[5,"13"]]]],[10,[1,[6,"rotl",[[1,[8,[7,"gpuSeed","$"],[5,"0"]],"*",[5,"2654435771"]],[5,"5"]]],"*",[5,"5"]]]]],[0,[[13,"s0",[8,"cpuSeed",[5,"0"]]],[12,"s1",[8,"cpuSeed",[5,"1"]]],[2,"s1","^=","s0"],[6,"updateCpuSeed",[[6,"d.vec2u",[[1,[1,[6,"rotl",["s0",[5,"26"]]],"^","s1"],"^",[1,"s1","<<",[5,"9"]]],[6,"rotl",["s1",[5,"13"]]]]]]],[10,[6,"Math.imul",[[6,"rotl",[[6,"Math.imul",[[8,"cpuSeed",[5,"0"]],[5,"2654435771"]]],[5,"5"]]],[5,"5"]]]]]]]]]},
    externals: {"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"rotl":() => rotl,"cpuSeed":() => cpuSeed,"updateCpuSeed":() => updateCpuSeed,"d.vec2u":() => d$1.vec2u,"Math.imul":() => Math.imul}
  }) && $.f)({}))), "next"));
  return {
    seed: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.f32])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      const scrambled = scrambleSeed(value);
      const newSeed = d$1.vec2u(hash(scrambled), hash(rotl(scrambled, 16)));
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = d$1.vec2u(newSeed);
      } else {
        updateCpuSeed(newSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"scrambled",[6,"scrambleSeed",["value"]]],[13,"newSeed",[6,"d.vec2u",[[6,"hash",["scrambled"]],[6,"hash",[[6,"rotl",["scrambled",[5,"16"]]]]]]]],[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=",[6,"d.vec2u",["newSeed"]]]]],[0,[[6,"updateCpuSeed",["newSeed"]]]]]]]},
    externals: {"scrambleSeed":() => scrambleSeed,"d.vec2u":() => d$1.vec2u,"hash":() => hash,"rotl":() => rotl,"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"updateCpuSeed":() => updateCpuSeed}
  }) && $.f)({}))), "seed")),
    seed2: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec2f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      const scrambled = scrambleSeed2(value);
      const newSeed = d$1.vec2u(
        hash(scrambled.x ^ scrambled.y),
        hash(rotl(scrambled.x, 16) ^ scrambled.y)
      );
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = d$1.vec2u(newSeed);
      } else {
        updateCpuSeed(newSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"scrambled",[6,"scrambleSeed2",["value"]]],[13,"newSeed",[6,"d.vec2u",[[6,"hash",[[1,[7,"scrambled","x"],"^",[7,"scrambled","y"]]]],[6,"hash",[[1,[6,"rotl",[[7,"scrambled","x"],[5,"16"]]],"^",[7,"scrambled","y"]]]]]]],[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=",[6,"d.vec2u",["newSeed"]]]]],[0,[[6,"updateCpuSeed",["newSeed"]]]]]]]},
    externals: {"scrambleSeed2":() => scrambleSeed2,"d.vec2u":() => d$1.vec2u,"hash":() => hash,"rotl":() => rotl,"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"updateCpuSeed":() => updateCpuSeed}
  }) && $.f)({}))), "seed2")),
    seed3: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec3f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      const scrambled = scrambleSeed3(value);
      const newSeed = d$1.vec2u(
        hash(scrambled.x ^ rotl(scrambled.z, 16)),
        hash(rotl(scrambled.y, 16) ^ scrambled.z)
      );
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = d$1.vec2u(newSeed);
      } else {
        updateCpuSeed(newSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"scrambled",[6,"scrambleSeed3",["value"]]],[13,"newSeed",[6,"d.vec2u",[[6,"hash",[[1,[7,"scrambled","x"],"^",[6,"rotl",[[7,"scrambled","z"],[5,"16"]]]]]],[6,"hash",[[1,[6,"rotl",[[7,"scrambled","y"],[5,"16"]]],"^",[7,"scrambled","z"]]]]]]],[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=",[6,"d.vec2u",["newSeed"]]]]],[0,[[6,"updateCpuSeed",["newSeed"]]]]]]]},
    externals: {"scrambleSeed3":() => scrambleSeed3,"d.vec2u":() => d$1.vec2u,"hash":() => hash,"rotl":() => rotl,"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"updateCpuSeed":() => updateCpuSeed}
  }) && $.f)({}))), "seed3")),
    seed4: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec4f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      const scrambled = scrambleSeed4(value);
      const newSeed = d$1.vec2u(
        hash(scrambled.x ^ rotl(scrambled.z, 16) ^ rotl(scrambled.w, 8)),
        hash(rotl(scrambled.y, 16) ^ scrambled.z ^ scrambled.w)
      );
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = d$1.vec2u(newSeed);
      } else {
        updateCpuSeed(newSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"scrambled",[6,"scrambleSeed4",["value"]]],[13,"newSeed",[6,"d.vec2u",[[6,"hash",[[1,[1,[7,"scrambled","x"],"^",[6,"rotl",[[7,"scrambled","z"],[5,"16"]]]],"^",[6,"rotl",[[7,"scrambled","w"],[5,"8"]]]]]],[6,"hash",[[1,[1,[6,"rotl",[[7,"scrambled","y"],[5,"16"]]],"^",[7,"scrambled","z"]],"^",[7,"scrambled","w"]]]]]]],[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=",[6,"d.vec2u",["newSeed"]]]]],[0,[[6,"updateCpuSeed",["newSeed"]]]]]]]},
    externals: {"scrambleSeed4":() => scrambleSeed4,"d.vec2u":() => d$1.vec2u,"hash":() => hash,"rotl":() => rotl,"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"updateCpuSeed":() => updateCpuSeed}
  }) && $.f)({}))), "seed4")),
    sample: randomGeneratorShell((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
      "use gpu";
      const r = next();
      return u32To01F32(r);
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[13,"r",[6,"next",[]]],[10,[6,"u32To01F32",["r"]]]]]},
    externals: {"next":() => next,"u32To01F32":() => u32To01F32}
  }) && $.f)({}))).$name("sample")
  };
})();
const LCG32 = (() => {
  const gpuSeed = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.privateVar(d$1.u32), "gpuSeed"));
  let cpuSeed = d$1.u32() | 0;
  function updateCpuSeed(seed) {
    cpuSeed = seed | 0;
  }
  const multiplier = 1664525;
  const increment = 1013904223;
  return {
    seed: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.f32])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      const scrambled = scrambleSeed(value);
      const newSeed = hash(scrambled) ^ hash(rotl(scrambled, 16));
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = newSeed;
      } else {
        updateCpuSeed(newSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"scrambled",[6,"scrambleSeed",["value"]]],[13,"newSeed",[1,[6,"hash",["scrambled"]],"^",[6,"hash",[[6,"rotl",["scrambled",[5,"16"]]]]]]],[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=","newSeed"]]],[0,[[6,"updateCpuSeed",["newSeed"]]]]]]]},
    externals: {"scrambleSeed":() => scrambleSeed,"hash":() => hash,"rotl":() => rotl,"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"updateCpuSeed":() => updateCpuSeed}
  }) && $.f)({}))), "seed")),
    seed2: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec2f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      const scrambled = scrambleSeed2(value);
      const newSeed = hash(scrambled.x ^ scrambled.y) ^ hash(rotl(scrambled.x, 16) ^ scrambled.y);
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = newSeed;
      } else {
        updateCpuSeed(newSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"scrambled",[6,"scrambleSeed2",["value"]]],[13,"newSeed",[1,[6,"hash",[[1,[7,"scrambled","x"],"^",[7,"scrambled","y"]]]],"^",[6,"hash",[[1,[6,"rotl",[[7,"scrambled","x"],[5,"16"]]],"^",[7,"scrambled","y"]]]]]],[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=","newSeed"]]],[0,[[6,"updateCpuSeed",["newSeed"]]]]]]]},
    externals: {"scrambleSeed2":() => scrambleSeed2,"hash":() => hash,"rotl":() => rotl,"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"updateCpuSeed":() => updateCpuSeed}
  }) && $.f)({}))), "seed2")),
    seed3: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec3f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      const scrambled = scrambleSeed3(value);
      const newSeed = hash(scrambled.x ^ rotl(scrambled.z, 16)) ^ hash(rotl(scrambled.y, 16) ^ scrambled.z);
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = newSeed;
      } else {
        updateCpuSeed(newSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"scrambled",[6,"scrambleSeed3",["value"]]],[13,"newSeed",[1,[6,"hash",[[1,[7,"scrambled","x"],"^",[6,"rotl",[[7,"scrambled","z"],[5,"16"]]]]]],"^",[6,"hash",[[1,[6,"rotl",[[7,"scrambled","y"],[5,"16"]]],"^",[7,"scrambled","z"]]]]]],[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=","newSeed"]]],[0,[[6,"updateCpuSeed",["newSeed"]]]]]]]},
    externals: {"scrambleSeed3":() => scrambleSeed3,"hash":() => hash,"rotl":() => rotl,"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"updateCpuSeed":() => updateCpuSeed}
  }) && $.f)({}))), "seed3")),
    seed4: (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec4f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((value) => {
      const scrambled = scrambleSeed4(value);
      const newSeed = hash(scrambled.x ^ rotl(scrambled.z, 16) ^ rotl(scrambled.w, 8)) ^ hash(rotl(scrambled.y, 16) ^ scrambled.z ^ scrambled.w);
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = newSeed;
      } else {
        updateCpuSeed(newSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"value"}],"body":[0,[[13,"scrambled",[6,"scrambleSeed4",["value"]]],[13,"newSeed",[1,[6,"hash",[[1,[1,[7,"scrambled","x"],"^",[6,"rotl",[[7,"scrambled","z"],[5,"16"]]]],"^",[6,"rotl",[[7,"scrambled","w"],[5,"8"]]]]]],"^",[6,"hash",[[1,[1,[6,"rotl",[[7,"scrambled","y"],[5,"16"]]],"^",[7,"scrambled","z"]],"^",[7,"scrambled","w"]]]]]],[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=","newSeed"]]],[0,[[6,"updateCpuSeed",["newSeed"]]]]]]]},
    externals: {"scrambleSeed4":() => scrambleSeed4,"hash":() => hash,"rotl":() => rotl,"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"updateCpuSeed":() => updateCpuSeed}
  }) && $.f)({}))), "seed4")),
    sample: randomGeneratorShell((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
      "use gpu";
      if (std.isBeingTranspiled()) {
        gpuSeed.$ = __tsover_add(__tsover_mul(multiplier, gpuSeed.$), increment);
        return u32To01F32(gpuSeed.$);
      } else {
        updateCpuSeed(__tsover_add(Math.imul(multiplier, cpuSeed), increment));
        return u32To01F32(cpuSeed);
      }
    }), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[11,[6,"std.isBeingTranspiled",[]],[0,[[2,[7,"gpuSeed","$"],"=",[1,[1,"multiplier","*",[7,"gpuSeed","$"]],"+","increment"]],[10,[6,"u32To01F32",[[7,"gpuSeed","$"]]]]]],[0,[[6,"updateCpuSeed",[[1,[6,"Math.imul",["multiplier","cpuSeed"]],"+","increment"]]],[10,[6,"u32To01F32",["cpuSeed"]]]]]]]]},
    externals: {"std.isBeingTranspiled":() => std.isBeingTranspiled,"gpuSeed":() => gpuSeed,"multiplier":() => multiplier,"increment":() => increment,"u32To01F32":() => u32To01F32,"updateCpuSeed":() => updateCpuSeed,"Math.imul":() => Math.imul,"cpuSeed":() => cpuSeed}
  }) && $.f)({}))).$name("sample")
  };
})();
const DefaultGenerator = XOROSHIRO64STARSTAR;
const randomGeneratorSlot = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.slot(DefaultGenerator), "randomGeneratorSlot"));

const TWO_PI = Math.PI * 2;
const EPS = 1e-7;
const warnIfNotProvided = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.comptime((seedFnName) => {
  if (!randomGeneratorSlot.$[seedFnName]) {
    console.warn(`Called \`randf.${seedFnName}\`, but it wasn't provided`);
  }
}), "warnIfNotProvided"));
const randSeed = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.f32])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((seed) => {
  warnIfNotProvided("seed");
  randomGeneratorSlot.$.seed ? randomGeneratorSlot.$.seed(seed) : void 0;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"seed"}],"body":[0,[[6,"warnIfNotProvided",[[103,"seed"]]],[105,[7,[7,"randomGeneratorSlot","$"],"seed"],[6,[7,[7,"randomGeneratorSlot","$"],"seed"],["seed"]],[4,"void",[5,"0"]]]]]},
    externals: {"warnIfNotProvided":() => warnIfNotProvided,"randomGeneratorSlot":() => randomGeneratorSlot}
  }) && $.f)({}))), "randSeed"));
const randSeed2 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec2f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((seed) => {
  warnIfNotProvided("seed2");
  randomGeneratorSlot.$.seed2 ? randomGeneratorSlot.$.seed2(seed) : void 0;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"seed"}],"body":[0,[[6,"warnIfNotProvided",[[103,"seed2"]]],[105,[7,[7,"randomGeneratorSlot","$"],"seed2"],[6,[7,[7,"randomGeneratorSlot","$"],"seed2"],["seed"]],[4,"void",[5,"0"]]]]]},
    externals: {"warnIfNotProvided":() => warnIfNotProvided,"randomGeneratorSlot":() => randomGeneratorSlot}
  }) && $.f)({}))), "randSeed2"));
const randSeed3 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec3f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((seed) => {
  warnIfNotProvided("seed3");
  randomGeneratorSlot.$.seed3 ? randomGeneratorSlot.$.seed3(seed) : void 0;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"seed"}],"body":[0,[[6,"warnIfNotProvided",[[103,"seed3"]]],[105,[7,[7,"randomGeneratorSlot","$"],"seed3"],[6,[7,[7,"randomGeneratorSlot","$"],"seed3"],["seed"]],[4,"void",[5,"0"]]]]]},
    externals: {"warnIfNotProvided":() => warnIfNotProvided,"randomGeneratorSlot":() => randomGeneratorSlot}
  }) && $.f)({}))), "randSeed3"));
const randSeed4 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn([d$1.vec4f])((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((seed) => {
  warnIfNotProvided("seed4");
  randomGeneratorSlot.$.seed4 ? randomGeneratorSlot.$.seed4(seed) : void 0;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"seed"}],"body":[0,[[6,"warnIfNotProvided",[[103,"seed4"]]],[105,[7,[7,"randomGeneratorSlot","$"],"seed4"],[6,[7,[7,"randomGeneratorSlot","$"],"seed4"],["seed"]],[4,"void",[5,"0"]]]]]},
    externals: {"warnIfNotProvided":() => warnIfNotProvided,"randomGeneratorSlot":() => randomGeneratorSlot}
  }) && $.f)({}))), "randSeed4"));
const randFloat01 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [],
  d$1.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => randomGeneratorSlot.$.sample()), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[10,[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]]]]},
    externals: {"randomGeneratorSlot":() => randomGeneratorSlot}
  }) && $.f)({}))), "randFloat01"));
const randInUnitCube = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [],
  d$1.vec3f
)(
  (/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => d$1.vec3f(
    randomGeneratorSlot.$.sample(),
    randomGeneratorSlot.$.sample(),
    randomGeneratorSlot.$.sample()
  )), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[10,[6,"d.vec3f",[[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]],[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]],[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]]]]]]},
    externals: {"d.vec3f":() => d$1.vec3f,"randomGeneratorSlot":() => randomGeneratorSlot}
  }) && $.f)({}))
), "randInUnitCube"));
const randOnUnitCube = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [],
  d$1.vec3f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
  const face = d$1.u32(randomGeneratorSlot.$.sample() * 6);
  const axis = face % 3;
  const result = d$1.vec3f();
  result[axis] = d$1.f32(select(0, 1, face > 2));
  result[(axis + 1) % 3] = randomGeneratorSlot.$.sample();
  result[(axis + 2) % 3] = randomGeneratorSlot.$.sample();
  return result;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[13,"face",[6,"d.u32",[[1,[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]],"*",[5,"6"]]]]],[13,"axis",[1,"face","%",[5,"3"]]],[13,"result",[6,"d.vec3f",[]]],[2,[8,"result","axis"],"=",[6,"d.f32",[[6,"select",[[5,"0"],[5,"1"],[1,"face",">",[5,"2"]]]]]]],[2,[8,"result",[1,[1,"axis","+",[5,"1"]],"%",[5,"3"]]],"=",[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]],[2,[8,"result",[1,[1,"axis","+",[5,"2"]],"%",[5,"3"]]],"=",[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]],[10,"result"]]]},
    externals: {"d.u32":() => d$1.u32,"randomGeneratorSlot":() => randomGeneratorSlot,"d.vec3f":() => d$1.vec3f,"d.f32":() => d$1.f32,"select":() => select}
  }) && $.f)({}))), "randOnUnitCube"));
const randInUnitCircle = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [],
  d$1.vec2f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
  const radius = sqrt(randomGeneratorSlot.$.sample());
  const angle = randomGeneratorSlot.$.sample() * TWO_PI;
  return d$1.vec2f(cos(angle) * radius, sin(angle) * radius);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[13,"radius",[6,"sqrt",[[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]]]],[13,"angle",[1,[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]],"*","TWO_PI"]],[10,[6,"d.vec2f",[[1,[6,"cos",["angle"]],"*","radius"],[1,[6,"sin",["angle"]],"*","radius"]]]]]]},
    externals: {"sqrt":() => sqrt,"randomGeneratorSlot":() => randomGeneratorSlot,"TWO_PI":() => TWO_PI,"d.vec2f":() => d$1.vec2f,"cos":() => cos,"sin":() => sin}
  }) && $.f)({}))), "randInUnitCircle"));
const randOnUnitCircle = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [],
  d$1.vec2f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
  const angle = randomGeneratorSlot.$.sample() * TWO_PI;
  return d$1.vec2f(cos(angle), sin(angle));
}), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[13,"angle",[1,[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]],"*","TWO_PI"]],[10,[6,"d.vec2f",[[6,"cos",["angle"]],[6,"sin",["angle"]]]]]]]},
    externals: {"randomGeneratorSlot":() => randomGeneratorSlot,"TWO_PI":() => TWO_PI,"d.vec2f":() => d$1.vec2f,"cos":() => cos,"sin":() => sin}
  }) && $.f)({}))), "randOnUnitCircle"));
const randInUnitSphere = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [],
  d$1.vec3f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
  "use gpu";
  const u = randomGeneratorSlot.$.sample();
  const v = d$1.vec3f(randNormal(0, 1), randNormal(0, 1), randNormal(0, 1));
  const vNorm = normalize(v);
  return __tsover_mul(vNorm, u ** 0.33);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[13,"u",[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]],[13,"v",[6,"d.vec3f",[[6,"randNormal",[[5,"0"],[5,"1"]]],[6,"randNormal",[[5,"0"],[5,"1"]]],[6,"randNormal",[[5,"0"],[5,"1"]]]]]],[13,"vNorm",[6,"normalize",["v"]]],[10,[1,"vNorm","*",[1,"u","**",[5,"0.33"]]]]]]},
    externals: {"randomGeneratorSlot":() => randomGeneratorSlot,"d.vec3f":() => d$1.vec3f,"randNormal":() => randNormal,"normalize":() => normalize}
  }) && $.f)({}))), "randInUnitSphere"));
const randOnUnitSphere = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [],
  d$1.vec3f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
  const z = 2 * randomGeneratorSlot.$.sample() - 1;
  const oneMinusZSq = sqrt(1 - z * z);
  const theta = TWO_PI * randomGeneratorSlot.$.sample();
  const x = cos(theta) * oneMinusZSq;
  const y = sin(theta) * oneMinusZSq;
  return d$1.vec3f(x, y, z);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[13,"z",[1,[1,[5,"2"],"*",[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]],"-",[5,"1"]]],[13,"oneMinusZSq",[6,"sqrt",[[1,[5,"1"],"-",[1,"z","*","z"]]]]],[13,"theta",[1,"TWO_PI","*",[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]]],[13,"x",[1,[6,"cos",["theta"]],"*","oneMinusZSq"]],[13,"y",[1,[6,"sin",["theta"]],"*","oneMinusZSq"]],[10,[6,"d.vec3f",["x","y","z"]]]]]},
    externals: {"randomGeneratorSlot":() => randomGeneratorSlot,"sqrt":() => sqrt,"TWO_PI":() => TWO_PI,"cos":() => cos,"sin":() => sin,"d.vec3f":() => d$1.vec3f}
  }) && $.f)({}))), "randOnUnitSphere"));
const randInUnitHemisphere = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.vec3f],
  d$1.vec3f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((normal) => {
  "use gpu";
  const value = randInUnitSphere();
  const alignment = dot(normal, value);
  return __tsover_mul(sign(alignment), value);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"normal"}],"body":[0,[[13,"value",[6,"randInUnitSphere",[]]],[13,"alignment",[6,"dot",["normal","value"]]],[10,[1,[6,"sign",["alignment"]],"*","value"]]]]},
    externals: {"randInUnitSphere":() => randInUnitSphere,"dot":() => dot,"sign":() => sign}
  }) && $.f)({}))), "randInUnitHemisphere"));
const randOnUnitHemisphere = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.vec3f],
  d$1.vec3f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((normal) => {
  "use gpu";
  const value = randOnUnitSphere();
  const alignment = dot(normal, value);
  return __tsover_mul(sign(alignment), value);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"normal"}],"body":[0,[[13,"value",[6,"randOnUnitSphere",[]]],[13,"alignment",[6,"dot",["normal","value"]]],[10,[1,[6,"sign",["alignment"]],"*","value"]]]]},
    externals: {"randOnUnitSphere":() => randOnUnitSphere,"dot":() => dot,"sign":() => sign}
  }) && $.f)({}))), "randOnUnitHemisphere"));
const randUniformExclusive = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [],
  d$1.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (() => {
  return randomGeneratorSlot.$.sample() * (1 - 2 * EPS) + EPS;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[],"body":[0,[[10,[1,[1,[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]],"*",[1,[5,"1"],"-",[1,[5,"2"],"*","EPS"]]],"+","EPS"]]]]},
    externals: {"randomGeneratorSlot":() => randomGeneratorSlot,"EPS":() => EPS}
  }) && $.f)({}))), "randUniformExclusive"));
const randNormal = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.f32, d$1.f32],
  d$1.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((mu, sigma) => {
  const theta = TWO_PI * randUniformExclusive();
  const R = sqrt(-2 * log(randUniformExclusive()));
  return R * sin(theta) * sigma + mu;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"mu"},{"type":"i","name":"sigma"}],"body":[0,[[13,"theta",[1,"TWO_PI","*",[6,"randUniformExclusive",[]]]],[13,"R",[6,"sqrt",[[1,[4,"-",[5,"2"]],"*",[6,"log",[[6,"randUniformExclusive",[]]]]]]]],[10,[1,[1,[1,"R","*",[6,"sin",["theta"]]],"*","sigma"],"+","mu"]]]]},
    externals: {"TWO_PI":() => TWO_PI,"randUniformExclusive":() => randUniformExclusive,"sqrt":() => sqrt,"log":() => log,"sin":() => sin}
  }) && $.f)({}))), "randNormal"));
const randExponential = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.f32],
  d$1.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((rate) => {
  const u = randUniformExclusive();
  return -1 / rate * log(u);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"rate"}],"body":[0,[[13,"u",[6,"randUniformExclusive",[]]],[10,[1,[1,[4,"-",[5,"1"]],"/","rate"],"*",[6,"log",["u"]]]]]]},
    externals: {"randUniformExclusive":() => randUniformExclusive,"log":() => log}
  }) && $.f)({}))), "randExponential"));
const randCauchy = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.f32, d$1.f32],
  d$1.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((x0, gamma) => {
  const u = randUniformExclusive();
  return x0 + gamma * tan(Math.PI * (u - 0.5));
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"x0"},{"type":"i","name":"gamma"}],"body":[0,[[13,"u",[6,"randUniformExclusive",[]]],[10,[1,"x0","+",[1,"gamma","*",[6,"tan",[[1,"Math.PI","*",[1,"u","-",[5,"0.5"]]]]]]]]]]},
    externals: {"randUniformExclusive":() => randUniformExclusive,"tan":() => tan,"Math.PI":() => Math.PI}
  }) && $.f)({}))), "randCauchy"));
const randBernoulli = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.f32],
  d$1.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((p) => {
  const u = randomGeneratorSlot.$.sample();
  return step(u, p);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"p"}],"body":[0,[[13,"u",[6,[7,[7,"randomGeneratorSlot","$"],"sample"],[]]],[10,[6,"step",["u","p"]]]]]},
    externals: {"randomGeneratorSlot":() => randomGeneratorSlot,"step":() => step}
  }) && $.f)({}))), "randBernoulli"));

const computeJunctionGradient$1 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.vec2i],
  d$1.vec2f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
  "use gpu";
  randSeed2(__tsover_mul(1e-3, d$1.vec2f(pos)));
  return randOnUnitCircle();
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[6,"randSeed2",[[1,[5,"0.001"],"*",[6,"d.vec2f",["pos"]]]]],[10,[6,"randOnUnitCircle",[]]]]]},
    externals: {"randSeed2":() => randSeed2,"d.vec2f":() => d$1.vec2f,"randOnUnitCircle":() => randOnUnitCircle}
  }) && $.f)({}))), "computeJunctionGradient"));
const getJunctionGradientSlot$1 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.slot(computeJunctionGradient$1), "getJunctionGradientSlot"));
const sample$1 = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.vec2f],
  d$1.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
  "use gpu";
  const i = d$1.vec2i(floor(pos));
  const f = fract(pos);
  const u = quinticInterpolation(f);
  const ga = getJunctionGradientSlot$1.$(i);
  const gb = getJunctionGradientSlot$1.$(__tsover_add(i, d$1.vec2i(1, 0)));
  const gc = getJunctionGradientSlot$1.$(__tsover_add(i, d$1.vec2i(0, 1)));
  const gd = getJunctionGradientSlot$1.$(__tsover_add(i, d$1.vec2i(1, 1)));
  const va = dot(ga, __tsover_sub(f, d$1.vec2f(0, 0)));
  const vb = dot(gb, __tsover_sub(f, d$1.vec2f(1, 0)));
  const vc = dot(gc, __tsover_sub(f, d$1.vec2f(0, 1)));
  const vd = dot(gd, __tsover_sub(f, d$1.vec2f(1, 1)));
  const noise = __tsover_add(__tsover_add(__tsover_add(va, __tsover_mul(u.x, __tsover_sub(vb, va))), __tsover_mul(u.y, __tsover_sub(vc, va))), __tsover_mul(__tsover_mul(u.x, u.y), __tsover_add(__tsover_sub(__tsover_sub(va, vb), vc), vd)));
  return noise;
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[13,"i",[6,"d.vec2i",[[6,"floor",["pos"]]]]],[13,"f",[6,"fract",["pos"]]],[13,"u",[6,"quinticInterpolation",["f"]]],[13,"ga",[6,[7,"getJunctionGradientSlot","$"],["i"]]],[13,"gb",[6,[7,"getJunctionGradientSlot","$"],[[1,"i","+",[6,"d.vec2i",[[5,"1"],[5,"0"]]]]]]],[13,"gc",[6,[7,"getJunctionGradientSlot","$"],[[1,"i","+",[6,"d.vec2i",[[5,"0"],[5,"1"]]]]]]],[13,"gd",[6,[7,"getJunctionGradientSlot","$"],[[1,"i","+",[6,"d.vec2i",[[5,"1"],[5,"1"]]]]]]],[13,"va",[6,"dot",["ga",[1,"f","-",[6,"d.vec2f",[[5,"0"],[5,"0"]]]]]]],[13,"vb",[6,"dot",["gb",[1,"f","-",[6,"d.vec2f",[[5,"1"],[5,"0"]]]]]]],[13,"vc",[6,"dot",["gc",[1,"f","-",[6,"d.vec2f",[[5,"0"],[5,"1"]]]]]]],[13,"vd",[6,"dot",["gd",[1,"f","-",[6,"d.vec2f",[[5,"1"],[5,"1"]]]]]]],[13,"noise",[1,[1,[1,"va","+",[1,[7,"u","x"],"*",[1,"vb","-","va"]]],"+",[1,[7,"u","y"],"*",[1,"vc","-","va"]]],"+",[1,[1,[7,"u","x"],"*",[7,"u","y"]],"*",[1,[1,[1,"va","-","vb"],"-","vc"],"+","vd"]]]],[10,"noise"]]]},
    externals: {"d.vec2i":() => d$1.vec2i,"floor":() => floor,"fract":() => fract,"quinticInterpolation":() => quinticInterpolation,"getJunctionGradientSlot":() => getJunctionGradientSlot$1,"dot":() => dot,"d.vec2f":() => d$1.vec2f}
  }) && $.f)({}))), "sample"));
const sampleWithGradient = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d$1.vec2f],
  d$1.vec3f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
  "use gpu";
  const i = d$1.vec2i(floor(pos));
  const f = fract(pos);
  const u = quinticInterpolation(f);
  const du = quinticDerivative(f);
  const ga = getJunctionGradientSlot$1.$(i);
  const gb = getJunctionGradientSlot$1.$(__tsover_add(i, d$1.vec2i(1, 0)));
  const gc = getJunctionGradientSlot$1.$(__tsover_add(i, d$1.vec2i(0, 1)));
  const gd = getJunctionGradientSlot$1.$(__tsover_add(i, d$1.vec2i(1, 1)));
  const va = dot(ga, __tsover_sub(f, d$1.vec2f(0, 0)));
  const vb = dot(gb, __tsover_sub(f, d$1.vec2f(1, 0)));
  const vc = dot(gc, __tsover_sub(f, d$1.vec2f(0, 1)));
  const vd = dot(gd, __tsover_sub(f, d$1.vec2f(1, 1)));
  const noise = __tsover_add(__tsover_add(__tsover_add(va, __tsover_mul(u.x, __tsover_sub(vb, va))), __tsover_mul(u.y, __tsover_sub(vc, va))), __tsover_mul(__tsover_mul(u.x, u.y), __tsover_add(__tsover_sub(__tsover_sub(va, vb), vc), vd)));
  const grad = __tsover_add(__tsover_add(__tsover_add(__tsover_add(ga, __tsover_mul(u.x, __tsover_sub(gb, ga))), __tsover_mul(u.y, __tsover_sub(gc, ga))), __tsover_mul(__tsover_mul(u.x, u.y), __tsover_add(__tsover_sub(__tsover_sub(ga, gb), gc), gd))), __tsover_mul(du, __tsover_sub(__tsover_add(__tsover_mul(u.yx, __tsover_add(__tsover_sub(__tsover_sub(va, vb), vc), vd)), d$1.vec2f(vb, vc)), va)));
  return d$1.vec3f(noise, grad);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[13,"i",[6,"d.vec2i",[[6,"floor",["pos"]]]]],[13,"f",[6,"fract",["pos"]]],[13,"u",[6,"quinticInterpolation",["f"]]],[13,"du",[6,"quinticDerivative",["f"]]],[13,"ga",[6,[7,"getJunctionGradientSlot","$"],["i"]]],[13,"gb",[6,[7,"getJunctionGradientSlot","$"],[[1,"i","+",[6,"d.vec2i",[[5,"1"],[5,"0"]]]]]]],[13,"gc",[6,[7,"getJunctionGradientSlot","$"],[[1,"i","+",[6,"d.vec2i",[[5,"0"],[5,"1"]]]]]]],[13,"gd",[6,[7,"getJunctionGradientSlot","$"],[[1,"i","+",[6,"d.vec2i",[[5,"1"],[5,"1"]]]]]]],[13,"va",[6,"dot",["ga",[1,"f","-",[6,"d.vec2f",[[5,"0"],[5,"0"]]]]]]],[13,"vb",[6,"dot",["gb",[1,"f","-",[6,"d.vec2f",[[5,"1"],[5,"0"]]]]]]],[13,"vc",[6,"dot",["gc",[1,"f","-",[6,"d.vec2f",[[5,"0"],[5,"1"]]]]]]],[13,"vd",[6,"dot",["gd",[1,"f","-",[6,"d.vec2f",[[5,"1"],[5,"1"]]]]]]],[13,"noise",[1,[1,[1,"va","+",[1,[7,"u","x"],"*",[1,"vb","-","va"]]],"+",[1,[7,"u","y"],"*",[1,"vc","-","va"]]],"+",[1,[1,[7,"u","x"],"*",[7,"u","y"]],"*",[1,[1,[1,"va","-","vb"],"-","vc"],"+","vd"]]]],[13,"grad",[1,[1,[1,[1,"ga","+",[1,[7,"u","x"],"*",[1,"gb","-","ga"]]],"+",[1,[7,"u","y"],"*",[1,"gc","-","ga"]]],"+",[1,[1,[7,"u","x"],"*",[7,"u","y"]],"*",[1,[1,[1,"ga","-","gb"],"-","gc"],"+","gd"]]],"+",[1,"du","*",[1,[1,[1,[7,"u","yx"],"*",[1,[1,[1,"va","-","vb"],"-","vc"],"+","vd"]],"+",[6,"d.vec2f",["vb","vc"]]],"-","va"]]]],[10,[6,"d.vec3f",["noise","grad"]]]]]},
    externals: {"d.vec2i":() => d$1.vec2i,"floor":() => floor,"fract":() => fract,"quinticInterpolation":() => quinticInterpolation,"quinticDerivative":() => quinticDerivative,"getJunctionGradientSlot":() => getJunctionGradientSlot$1,"dot":() => dot,"d.vec2f":() => d$1.vec2f,"d.vec3f":() => d$1.vec3f}
  }) && $.f)({}))), "sampleWithGradient"));

const MemorySchema$3 = d.arrayOf(d.vec2f);
const DefaultPerlin2DLayoutPrefix = "perlin2dCache__";
function dynamicCacheConfig$1(options) {
  const { prefix = DefaultPerlin2DLayoutPrefix } = options ?? {};
  const sizeAccess = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.accessor(d.vec2u), "sizeAccess"));
  const memoryAccess = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.accessor(MemorySchema$3), "memoryAccess"));
  const getJunctionGradient = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
    [d.vec2i],
    d.vec2f
  )((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
    const size = d.vec2i(sizeAccess.$);
    const x = (pos.x % size.x + size.x) % size.x;
    const y = (pos.y % size.y + size.y) % size.y;
    return memoryAccess.$[x + y * size.x];
  }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[13,"size",[6,"d.vec2i",[[7,"sizeAccess","$"]]]],[13,"x",[1,[1,[1,[7,"pos","x"],"%",[7,"size","x"]],"+",[7,"size","x"]],"%",[7,"size","x"]]],[13,"y",[1,[1,[1,[7,"pos","y"],"%",[7,"size","y"]],"+",[7,"size","y"]],"%",[7,"size","y"]]],[10,[8,[7,"memoryAccess","$"],[1,"x","+",[1,"y","*",[7,"size","x"]]]]]]]},
    externals: {"d.vec2i":() => d.vec2i,"sizeAccess":() => sizeAccess,"memoryAccess":() => memoryAccess}
  }) && $.f)({}))), "getJunctionGradient"));
  const computeLayout = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.bindGroupLayout({
    size: { uniform: d.vec2u },
    memory: { storage: MemorySchema$3, access: "mutable" }
  }), "computeLayout"));
  const mainCompute = (/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((x, y) => {
    "use gpu";
    const size = computeLayout.$.size;
    const idx = __tsover_add(x, __tsover_mul(y, size.x));
    computeLayout.$.memory[idx] = computeJunctionGradient$1(d.vec2i(x, y));
  }), {
    v: 2,
    name: "mainCompute",
    ast: {"params":[{"type":"i","name":"x"},{"type":"i","name":"y"}],"body":[0,[[13,"size",[7,[7,"computeLayout","$"],"size"]],[13,"idx",[1,"x","+",[1,"y","*",[7,"size","x"]]]],[2,[8,[7,[7,"computeLayout","$"],"memory"],"idx"],"=",[6,"computeJunctionGradient",[[6,"d.vec2i",["x","y"]]]]]]]},
    externals: {"computeLayout":() => computeLayout,"computeJunctionGradient":() => computeJunctionGradient$1,"d.vec2i":() => d.vec2i}
  }) && $.f)({}));
  const instance = (root, initialSize) => {
    let dirty = false;
    let size = initialSize;
    const sizeBuffer = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createBuffer(d.vec2u, size).$usage("uniform"), "sizeBuffer"));
    const computePipeline = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createGuardedComputePipeline(mainCompute), "computePipeline"));
    const createMemory = () => {
      const memory = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createBuffer(d.arrayOf(d.vec2f, size.x * size.y)).$usage("storage"), "memory"));
      const computeBindGroup = root.createBindGroup(computeLayout, {
        size: sizeBuffer,
        memory
      });
      computePipeline.with(computeBindGroup).dispatchThreads(size.x, size.y);
      return memory;
    };
    let memoryBuffer = createMemory();
    return {
      get size() {
        return size;
      },
      get bindings() {
        if (dirty) {
          memoryBuffer.destroy();
          memoryBuffer = createMemory();
          dirty = false;
        }
        return {
          [`${prefix}size`]: sizeBuffer,
          [`${prefix}memory`]: memoryBuffer
        };
      },
      set size(value) {
        if (allEq(size, value)) {
          return;
        }
        size = value;
        sizeBuffer.write(size);
        dirty = true;
      },
      destroy() {
        sizeBuffer.destroy();
        memoryBuffer.destroy();
      }
    };
  };
  return {
    layout: {
      [`${prefix}size`]: { uniform: d.vec2u },
      [`${prefix}memory`]: { storage: MemorySchema$3, access: "readonly" }
    },
    getJunctionGradient,
    instance,
    inject: (layoutValue) => (cfg) => cfg.with(getJunctionGradientSlot$1, getJunctionGradient).with(sizeAccess, () => layoutValue[`${prefix}size`]).with(memoryAccess, () => layoutValue[`${prefix}memory`])
  };
}

const MemorySchema$2 = d.arrayOf(d.vec2f);
function staticCache$1(options) {
  const { root, size } = options;
  const memoryBuffer = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createBuffer(MemorySchema$2(size.x * size.y)).$usage("storage"), "memoryBuffer"));
  const memoryReadonly = memoryBuffer.as("readonly");
  const memoryMutable = memoryBuffer.as("mutable");
  const computePipeline = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createGuardedComputePipeline((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((x, y) => {
    "use gpu";
    const idx = __tsover_add(x, __tsover_mul(y, size.x));
    memoryMutable.$[idx] = computeJunctionGradient$1(d.vec2i(x, y));
  }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"x"},{"type":"i","name":"y"}],"body":[0,[[13,"idx",[1,"x","+",[1,"y","*","size.x"]]],[2,[8,[7,"memoryMutable","$"],"idx"],"=",[6,"computeJunctionGradient",[[6,"d.vec2i",["x","y"]]]]]]]},
    externals: {"size.x":() => size.x,"memoryMutable":() => memoryMutable,"computeJunctionGradient":() => computeJunctionGradient$1,"d.vec2i":() => d.vec2i}
  }) && $.f)({}))), "computePipeline"));
  computePipeline.dispatchThreads(size.x, size.y);
  const getJunctionGradient = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
    [d.vec2i],
    d.vec2f
  )((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
    const size_i = d.vec2i(size);
    const x = (pos.x % size_i.x + size_i.x) % size_i.x;
    const y = (pos.y % size_i.y + size_i.y) % size_i.y;
    return memoryReadonly.$[x + y * size_i.x];
  }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[13,"size_i",[6,"d.vec2i",["size"]]],[13,"x",[1,[1,[1,[7,"pos","x"],"%",[7,"size_i","x"]],"+",[7,"size_i","x"]],"%",[7,"size_i","x"]]],[13,"y",[1,[1,[1,[7,"pos","y"],"%",[7,"size_i","y"]],"+",[7,"size_i","y"]],"%",[7,"size_i","y"]]],[10,[8,[7,"memoryReadonly","$"],[1,"x","+",[1,"y","*",[7,"size_i","x"]]]]]]]},
    externals: {"d.vec2i":() => d.vec2i,"size":() => size,"memoryReadonly":() => memoryReadonly}
  }) && $.f)({}))), "getJunctionGradient"));
  return {
    getJunctionGradient,
    get size() {
      return size;
    },
    destroy() {
      memoryBuffer.destroy();
    },
    inject: () => (cfg) => cfg.with(getJunctionGradientSlot$1, getJunctionGradient)
  };
}

const index$1 = {
  __proto__: null,
  computeJunctionGradient: computeJunctionGradient$1,
  dynamicCacheConfig: dynamicCacheConfig$1,
  getJunctionGradientSlot: getJunctionGradientSlot$1,
  sample: sample$1,
  sampleWithGradient: sampleWithGradient,
  staticCache: staticCache$1
};

const computeJunctionGradient = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d.vec3i],
  d.vec3f
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
  "use gpu";
  randSeed3(__tsover_mul(1e-3, d.vec3f(pos)));
  return randOnUnitSphere();
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[6,"randSeed3",[[1,[5,"0.001"],"*",[6,"d.vec3f",["pos"]]]]],[10,[6,"randOnUnitSphere",[]]]]]},
    externals: {"randSeed3":() => randSeed3,"d.vec3f":() => d.vec3f,"randOnUnitSphere":() => randOnUnitSphere}
  }) && $.f)({}))), "computeJunctionGradient"));
const getJunctionGradientSlot = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.slot(computeJunctionGradient), "getJunctionGradientSlot"));
const dotProdGrid = (/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos, junction) => {
  "use gpu";
  const relative = __tsover_sub(pos, junction);
  const gridVector = getJunctionGradientSlot.$(d.vec3i(junction));
  return dot(relative, gridVector);
}), {
    v: 2,
    name: "dotProdGrid",
    ast: {"params":[{"type":"i","name":"pos"},{"type":"i","name":"junction"}],"body":[0,[[13,"relative",[1,"pos","-","junction"]],[13,"gridVector",[6,[7,"getJunctionGradientSlot","$"],[[6,"d.vec3i",["junction"]]]]],[10,[6,"dot",["relative","gridVector"]]]]]},
    externals: {"getJunctionGradientSlot":() => getJunctionGradientSlot,"d.vec3i":() => d.vec3i,"dot":() => dot}
  }) && $.f)({}));
const sample = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
  [d.vec3f],
  d.f32
)((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
  "use gpu";
  const minJunction = floor(pos);
  const xyz = dotProdGrid(pos, minJunction);
  const xyZ = dotProdGrid(pos, __tsover_add(minJunction, d.vec3f(0, 0, 1)));
  const xYz = dotProdGrid(pos, __tsover_add(minJunction, d.vec3f(0, 1, 0)));
  const xYZ = dotProdGrid(pos, __tsover_add(minJunction, d.vec3f(0, 1, 1)));
  const Xyz = dotProdGrid(pos, __tsover_add(minJunction, d.vec3f(1, 0, 0)));
  const XyZ = dotProdGrid(pos, __tsover_add(minJunction, d.vec3f(1, 0, 1)));
  const XYz = dotProdGrid(pos, __tsover_add(minJunction, d.vec3f(1, 1, 0)));
  const XYZ = dotProdGrid(pos, __tsover_add(minJunction, d.vec3f(1, 1, 1)));
  const partial = __tsover_sub(pos, minJunction);
  const smoothPartial = quinticInterpolation(partial);
  const xy = mix(xyz, xyZ, smoothPartial.z);
  const xY = mix(xYz, xYZ, smoothPartial.z);
  const Xy = mix(Xyz, XyZ, smoothPartial.z);
  const XY = mix(XYz, XYZ, smoothPartial.z);
  const x = mix(xy, xY, smoothPartial.y);
  const X = mix(Xy, XY, smoothPartial.y);
  return mix(x, X, smoothPartial.x);
}), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[13,"minJunction",[6,"floor",["pos"]]],[13,"xyz",[6,"dotProdGrid",["pos","minJunction"]]],[13,"xyZ",[6,"dotProdGrid",["pos",[1,"minJunction","+",[6,"d.vec3f",[[5,"0"],[5,"0"],[5,"1"]]]]]]],[13,"xYz",[6,"dotProdGrid",["pos",[1,"minJunction","+",[6,"d.vec3f",[[5,"0"],[5,"1"],[5,"0"]]]]]]],[13,"xYZ",[6,"dotProdGrid",["pos",[1,"minJunction","+",[6,"d.vec3f",[[5,"0"],[5,"1"],[5,"1"]]]]]]],[13,"Xyz",[6,"dotProdGrid",["pos",[1,"minJunction","+",[6,"d.vec3f",[[5,"1"],[5,"0"],[5,"0"]]]]]]],[13,"XyZ",[6,"dotProdGrid",["pos",[1,"minJunction","+",[6,"d.vec3f",[[5,"1"],[5,"0"],[5,"1"]]]]]]],[13,"XYz",[6,"dotProdGrid",["pos",[1,"minJunction","+",[6,"d.vec3f",[[5,"1"],[5,"1"],[5,"0"]]]]]]],[13,"XYZ",[6,"dotProdGrid",["pos",[1,"minJunction","+",[6,"d.vec3f",[[5,"1"],[5,"1"],[5,"1"]]]]]]],[13,"partial",[1,"pos","-","minJunction"]],[13,"smoothPartial",[6,"quinticInterpolation",["partial"]]],[13,"xy",[6,"mix",["xyz","xyZ",[7,"smoothPartial","z"]]]],[13,"xY",[6,"mix",["xYz","xYZ",[7,"smoothPartial","z"]]]],[13,"Xy",[6,"mix",["Xyz","XyZ",[7,"smoothPartial","z"]]]],[13,"XY",[6,"mix",["XYz","XYZ",[7,"smoothPartial","z"]]]],[13,"x",[6,"mix",["xy","xY",[7,"smoothPartial","y"]]]],[13,"X",[6,"mix",["Xy","XY",[7,"smoothPartial","y"]]]],[10,[6,"mix",["x","X",[7,"smoothPartial","x"]]]]]]},
    externals: {"floor":() => floor,"dotProdGrid":() => dotProdGrid,"d.vec3f":() => d.vec3f,"quinticInterpolation":() => quinticInterpolation,"mix":() => mix}
  }) && $.f)({}))), "sample"));

const MemorySchema$1 = d.arrayOf(d.vec3f);
const DefaultPerlin3DLayoutPrefix = "perlin3dCache__";
function dynamicCacheConfig(options) {
  const { prefix = DefaultPerlin3DLayoutPrefix } = options ?? {};
  const sizeAccess = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.accessor(d.vec4u), "sizeAccess"));
  const memoryAccess = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.accessor(MemorySchema$1), "memoryAccess"));
  const getJunctionGradient = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
    [d.vec3i],
    d.vec3f
  )((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
    const size = d.vec3i(sizeAccess.$.xyz);
    const x = (pos.x % size.x + size.x) % size.x;
    const y = (pos.y % size.y + size.y) % size.y;
    const z = (pos.z % size.z + size.z) % size.z;
    return memoryAccess.$[x + y * size.x + z * size.x * size.y];
  }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[13,"size",[6,"d.vec3i",[[7,[7,"sizeAccess","$"],"xyz"]]]],[13,"x",[1,[1,[1,[7,"pos","x"],"%",[7,"size","x"]],"+",[7,"size","x"]],"%",[7,"size","x"]]],[13,"y",[1,[1,[1,[7,"pos","y"],"%",[7,"size","y"]],"+",[7,"size","y"]],"%",[7,"size","y"]]],[13,"z",[1,[1,[1,[7,"pos","z"],"%",[7,"size","z"]],"+",[7,"size","z"]],"%",[7,"size","z"]]],[10,[8,[7,"memoryAccess","$"],[1,[1,"x","+",[1,"y","*",[7,"size","x"]]],"+",[1,[1,"z","*",[7,"size","x"]],"*",[7,"size","y"]]]]]]]},
    externals: {"d.vec3i":() => d.vec3i,"sizeAccess":() => sizeAccess,"memoryAccess":() => memoryAccess}
  }) && $.f)({}))), "getJunctionGradient"));
  const computeLayout = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.bindGroupLayout({
    size: { uniform: d.vec4u },
    memory: { storage: MemorySchema$1, access: "mutable" }
  }), "computeLayout"));
  const mainCompute = (/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((x, y, z) => {
    "use gpu";
    const size = computeLayout.$.size;
    const idx = __tsover_add(__tsover_add(x, __tsover_mul(y, size.x)), __tsover_mul(__tsover_mul(z, size.x), size.y));
    computeLayout.$.memory[idx] = computeJunctionGradient(d.vec3i(x, y, z));
  }), {
    v: 2,
    name: "mainCompute",
    ast: {"params":[{"type":"i","name":"x"},{"type":"i","name":"y"},{"type":"i","name":"z"}],"body":[0,[[13,"size",[7,[7,"computeLayout","$"],"size"]],[13,"idx",[1,[1,"x","+",[1,"y","*",[7,"size","x"]]],"+",[1,[1,"z","*",[7,"size","x"]],"*",[7,"size","y"]]]],[2,[8,[7,[7,"computeLayout","$"],"memory"],"idx"],"=",[6,"computeJunctionGradient",[[6,"d.vec3i",["x","y","z"]]]]]]]},
    externals: {"computeLayout":() => computeLayout,"computeJunctionGradient":() => computeJunctionGradient,"d.vec3i":() => d.vec3i}
  }) && $.f)({}));
  const instance = (root, initialSize) => {
    let dirty = false;
    let size = d.vec4u(initialSize, 0);
    const sizeBuffer = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createBuffer(d.vec4u, size).$usage("uniform"), "sizeBuffer"));
    const computePipeline = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createGuardedComputePipeline(mainCompute), "computePipeline"));
    const createMemory = () => {
      const memory = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createBuffer(d.arrayOf(d.vec3f, size.x * size.y * size.z)).$usage("storage"), "memory"));
      const computeBindGroup = root.createBindGroup(computeLayout, {
        size: sizeBuffer,
        memory
      });
      computePipeline.with(computeBindGroup).dispatchThreads(size.x, size.y, size.z);
      return memory;
    };
    let memoryBuffer = createMemory();
    return {
      get size() {
        return size.xyz;
      },
      get bindings() {
        if (dirty) {
          memoryBuffer.destroy();
          memoryBuffer = createMemory();
          dirty = false;
        }
        return {
          [`${prefix}size`]: sizeBuffer,
          [`${prefix}memory`]: memoryBuffer
        };
      },
      set size(_value) {
        const value = d.vec4u(_value, 0);
        if (allEq(size, value)) {
          return;
        }
        size = value;
        sizeBuffer.write(size);
        dirty = true;
      },
      destroy() {
        sizeBuffer.destroy();
        memoryBuffer.destroy();
      }
    };
  };
  return {
    layout: {
      [`${prefix}size`]: { uniform: d.vec4u },
      [`${prefix}memory`]: { storage: MemorySchema$1, access: "readonly" }
    },
    getJunctionGradient,
    instance,
    inject: (layoutValue) => (cfg) => cfg.with(getJunctionGradientSlot, getJunctionGradient).with(sizeAccess, () => layoutValue[`${prefix}size`]).with(memoryAccess, () => layoutValue[`${prefix}memory`])
  };
}

const MemorySchema = d.arrayOf(d.vec3f);
function staticCache(options) {
  const { root, size } = options;
  const memoryBuffer = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createBuffer(MemorySchema(size.x * size.y * size.z)).$usage("storage"), "memoryBuffer"));
  const memoryReadonly = memoryBuffer.as("readonly");
  const memoryMutable = memoryBuffer.as("mutable");
  const computePipeline = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(root.createGuardedComputePipeline((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((x, y, z) => {
    "use gpu";
    const idx = __tsover_add(__tsover_add(x, __tsover_mul(y, size.x)), __tsover_mul(__tsover_mul(z, size.x), size.y));
    memoryMutable.$[idx] = computeJunctionGradient(d.vec3i(x, y, z));
  }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"x"},{"type":"i","name":"y"},{"type":"i","name":"z"}],"body":[0,[[13,"idx",[1,[1,"x","+",[1,"y","*","size.x"]],"+",[1,[1,"z","*","size.x"],"*","size.y"]]],[2,[8,[7,"memoryMutable","$"],"idx"],"=",[6,"computeJunctionGradient",[[6,"d.vec3i",["x","y","z"]]]]]]]},
    externals: {"size.x":() => size.x,"size.y":() => size.y,"memoryMutable":() => memoryMutable,"computeJunctionGradient":() => computeJunctionGradient,"d.vec3i":() => d.vec3i}
  }) && $.f)({}))), "computePipeline"));
  computePipeline.dispatchThreads(size.x, size.y, size.z);
  const getJunctionGradient = (/*#__PURE__*/(globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(tgpu.fn(
    [d.vec3i],
    d.vec3f
  )((/*#__PURE__*/($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = ((pos) => {
    const size_i = d.vec3i(size);
    const x = (pos.x % size_i.x + size_i.x) % size_i.x;
    const y = (pos.y % size_i.y + size_i.y) % size_i.y;
    const z = (pos.z % size_i.z + size_i.z) % size_i.z;
    return memoryReadonly.$[x + y * size_i.x + z * size_i.x * size_i.y];
  }), {
    v: 2,
    name: undefined,
    ast: {"params":[{"type":"i","name":"pos"}],"body":[0,[[13,"size_i",[6,"d.vec3i",["size"]]],[13,"x",[1,[1,[1,[7,"pos","x"],"%",[7,"size_i","x"]],"+",[7,"size_i","x"]],"%",[7,"size_i","x"]]],[13,"y",[1,[1,[1,[7,"pos","y"],"%",[7,"size_i","y"]],"+",[7,"size_i","y"]],"%",[7,"size_i","y"]]],[13,"z",[1,[1,[1,[7,"pos","z"],"%",[7,"size_i","z"]],"+",[7,"size_i","z"]],"%",[7,"size_i","z"]]],[10,[8,[7,"memoryReadonly","$"],[1,[1,"x","+",[1,"y","*",[7,"size_i","x"]]],"+",[1,[1,"z","*",[7,"size_i","x"]],"*",[7,"size_i","y"]]]]]]]},
    externals: {"d.vec3i":() => d.vec3i,"size":() => size,"memoryReadonly":() => memoryReadonly}
  }) && $.f)({}))), "getJunctionGradient"));
  return {
    getJunctionGradient,
    get size() {
      return size;
    },
    destroy() {
      memoryBuffer.destroy();
    },
    inject: () => (cfg) => cfg.with(getJunctionGradientSlot, getJunctionGradient)
  };
}

const index = {
  __proto__: null,
  computeJunctionGradient: computeJunctionGradient,
  dynamicCacheConfig: dynamicCacheConfig,
  getJunctionGradientSlot: getJunctionGradientSlot,
  sample: sample,
  staticCache: staticCache
};

const randf = {
  seed: randSeed,
  seed2: randSeed2,
  seed3: randSeed3,
  seed4: randSeed4,
  sample: randFloat01,
  sampleExclusive: randUniformExclusive,
  normal: randNormal,
  exponential: randExponential,
  cauchy: randCauchy,
  bernoulli: randBernoulli,
  inUnitCircle: randInUnitCircle,
  onUnitCircle: randOnUnitCircle,
  inUnitCube: randInUnitCube,
  onUnitCube: randOnUnitCube,
  inHemisphere: randInUnitHemisphere,
  onHemisphere: randOnUnitHemisphere,
  inUnitSphere: randInUnitSphere,
  onUnitSphere: randOnUnitSphere
};

export { BPETER, DefaultGenerator, LCG32, XOROSHIRO64STARSTAR, hash, index$1 as perlin2d, index as perlin3d, randf, randomGeneratorShell, randomGeneratorSlot, rotl, scrambleSeed, scrambleSeed2, scrambleSeed3, scrambleSeed4, u32To01F32 };
