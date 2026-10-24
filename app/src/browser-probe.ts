// Real-GPU check support (NOT part of the library): with `?probe` in the URL, count GPU buffer
// creation/destruction and queue writes on the real device, so a browser session can assert
// ownership and write behavior. Read the numbers from `window.__gpuProbe`.
export interface GpuProbe {
  created: number;
  destroyed: number;
  writes: { bytes: number; at: number }[];
  /** Devices requested through this page; use `devices.at(-1).destroy()` to simulate device loss. */
  devices: GPUDevice[];
}

export function installGpuProbe(): void {
  if (typeof GPUDevice === 'undefined') return;
  const probe: GpuProbe = { created: 0, destroyed: 0, writes: [], devices: [] };
  (globalThis as { __gpuProbe?: GpuProbe }).__gpuProbe = probe;

  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
    const device = await requestDevice.call(this, descriptor);
    probe.devices.push(device);
    return device;
  };

  const createBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (this: GPUDevice, descriptor: GPUBufferDescriptor) {
    probe.created++;
    return createBuffer.call(this, descriptor);
  };
  const destroy = GPUBuffer.prototype.destroy;
  GPUBuffer.prototype.destroy = function (this: GPUBuffer) {
    probe.destroyed++;
    return destroy.call(this);
  };
  const writeBuffer = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (this: GPUQueue, ...args: Parameters<GPUQueue['writeBuffer']>) {
    const data = args[2] as ArrayBufferView | ArrayBuffer;
    probe.writes.push({ bytes: data.byteLength, at: performance.now() });
    return writeBuffer.apply(this, args);
  } as GPUQueue['writeBuffer'];
}
