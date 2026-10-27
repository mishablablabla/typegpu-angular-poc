// Where the pictures come from, for both implementations of MATRIX MIRROR: the user's camera, or a procedural demo scene
// (a canvas animation turned into a MediaStream), both played by one hidden <video> that the GPU imports as an external texture.
import { demoPose, isPersonVisible, type DemoPose, type SourceKind, type SourceStatus } from './matrix.model';

const DEMO_WIDTH = 640;
const DEMO_HEIGHT = 360;

export class VideoSource {
  readonly video = document.createElement('video');
  status: SourceStatus = 'idle';
  private stream: MediaStream | undefined;
  private demo: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | undefined;
  private generation = 0;
  private frameCallback = 0;
  private frames = 0;

  /** `onChange` is called whenever the status changes (and when the picture size is known). */
  constructor(private readonly onChange: () => void) {
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  /** Enough frames have arrived to be imported as a texture. */
  get ready(): boolean {
    return this.status === 'live' && this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  /** Changes whenever the picture has a new frame (a camera delivers 30 a second, the page draws 60). */
  get frameId(): number {
    return this.frames;
  }

  get size(): { width: number; height: number } {
    return { width: this.video.videoWidth || DEMO_WIDTH, height: this.video.videoHeight || DEMO_HEIGHT };
  }

  /** Starts (or restarts) the picture: stale results of an earlier start are ignored. */
  async start(kind: SourceKind): Promise<void> {
    const generation = ++this.generation;
    this.release();
    this.set('starting');
    try {
      let stream: MediaStream;
      if (kind === 'Camera') {
        if (!navigator.mediaDevices?.getUserMedia) {
          this.set('unavailable');
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = DEMO_WIDTH;
        canvas.height = DEMO_HEIGHT;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no 2d context');
        this.demo = { canvas, context };
        drawDemo(context, 0, 0);
        stream = canvas.captureStream(30);
      }
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      if (generation === this.generation) {
        this.countFrames(generation);
        this.set('live');
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.set(error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError') ? 'denied' : 'unavailable');
    }
  }

  /** Called every frame: the demo scene is redrawn (a camera needs nothing). */
  frame(time: number, presence: number): void {
    if (!('requestVideoFrameCallback' in this.video)) this.frames++;
    if (this.demo) drawDemo(this.demo.context, time, presence);
  }

  /** Stops the camera and the demo, and releases the stream. */
  stop(): void {
    this.generation++;
    this.release();
    this.status = 'idle';
  }

  /** Counts the frames the video decodes; without `requestVideoFrameCallback` every page frame counts as new. */
  private countFrames(generation: number): void {
    const video = this.video;
    if (!('requestVideoFrameCallback' in video)) return;
    const next = () => {
      if (generation !== this.generation) return;
      this.frames++;
      this.frameCallback = video.requestVideoFrameCallback(next);
    };
    this.frameCallback = video.requestVideoFrameCallback(next);
  }

  private release(): void {
    if (this.frameCallback) this.video.cancelVideoFrameCallback(this.frameCallback);
    this.frameCallback = 0;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.demo = undefined;
    this.video.pause();
    this.video.srcObject = null;
  }

  private set(status: SourceStatus): void {
    this.status = status;
    this.onChange();
  }
}

/** A room and a person, drawn with 2D canvas: the stand-in for a camera. */
function drawDemo(ctx: CanvasRenderingContext2D, time: number, presence: number): void {
  const w = DEMO_WIDTH;
  const h = DEMO_HEIGHT;
  // The room: a wall that is lighter towards a window, a floor with perspective lines, a shelf, a poster.
  const wall = ctx.createLinearGradient(0, 0, w, 0);
  wall.addColorStop(0, '#9bbad0');
  wall.addColorStop(0.5, '#6a8aa3');
  wall.addColorStop(1, '#4a5d72');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h * 0.72);
  const floor = ctx.createLinearGradient(0, h * 0.72, 0, h);
  floor.addColorStop(0, '#5a4c40');
  floor.addColorStop(1, '#86705c');
  ctx.fillStyle = floor;
  ctx.fillRect(0, h * 0.72, w, h * 0.28);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1.5;
  for (let i = -6; i <= 6; i++) {
    ctx.beginPath();
    ctx.moveTo(w / 2 + i * 40, h * 0.72);
    ctx.lineTo(w / 2 + i * 150, h);
    ctx.stroke();
  }
  // Window with a bright sky and mullions.
  const sky = ctx.createLinearGradient(0, 30, 0, 200);
  sky.addColorStop(0, '#f4fbff');
  sky.addColorStop(1, '#a9d4f0');
  ctx.fillStyle = sky;
  ctx.fillRect(50, 30, 150, 170);
  ctx.strokeStyle = '#23272d';
  ctx.lineWidth = 6;
  ctx.strokeRect(50, 30, 150, 170);
  ctx.beginPath();
  ctx.moveTo(125, 30);
  ctx.lineTo(125, 200);
  ctx.moveTo(50, 115);
  ctx.lineTo(200, 115);
  ctx.stroke();
  // A shelf with books and a lamp, and a poster; the lamp flickers a little so the room is not a still photograph.
  ctx.fillStyle = '#5a4634';
  ctx.fillRect(440, 130, 170, 8);
  const books = ['#c0523b', '#d8b24a', '#3e7d63', '#4d5fa8', '#a8a8a8'];
  books.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(450 + i * 18, 92, 14, 38);
  });
  ctx.fillStyle = '#f2e6b8';
  ctx.globalAlpha = 0.75 + 0.2 * Math.sin(time * 9);
  ctx.beginPath();
  ctx.arc(585, 112, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#e9e4da';
  ctx.fillRect(300, 40, 90, 120);
  ctx.fillStyle = '#c0523b';
  ctx.fillRect(312, 56, 66, 40);
  ctx.fillStyle = '#23272d';
  ctx.fillRect(312, 108, 66, 6);
  ctx.fillRect(312, 122, 40, 6);

  const pose = demoPose(time, presence);
  if (isPersonVisible(pose)) drawPerson(ctx, pose, w, h);
}

function drawPerson(ctx: CanvasRenderingContext2D, pose: DemoPose, w: number, h: number): void {
  const cx = pose.x * w;
  const baseY = h * 0.97;
  const scale = h / 360;
  ctx.save();
  ctx.translate(cx, baseY);
  ctx.rotate(pose.sway);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  // Legs.
  const swing = Math.sin(pose.step) * 12;
  ctx.strokeStyle = '#1e2733';
  ctx.lineWidth = 22;
  ctx.beginPath();
  ctx.moveTo(-14, -110);
  ctx.lineTo(-14 + swing, 0);
  ctx.moveTo(14, -110);
  ctx.lineTo(14 - swing, 0);
  ctx.stroke();
  // Arms behind the torso, then the torso with a shaded shirt.
  ctx.strokeStyle = '#d8a785';
  ctx.lineWidth = 15;
  const arm = (side: number, angle: number) => {
    const shoulderX = side * 40;
    const handX = shoulderX + side * Math.sin(angle) * 78;
    const handY = -215 + Math.cos(angle) * 78;
    ctx.beginPath();
    ctx.moveTo(shoulderX, -215);
    ctx.lineTo(handX, handY);
    ctx.stroke();
    ctx.fillStyle = '#d8a785';
    ctx.beginPath();
    ctx.arc(handX, handY, 11, 0, Math.PI * 2);
    ctx.fill();
  };
  arm(-1, pose.leftArm);
  arm(1, pose.rightArm);
  const shirt = ctx.createLinearGradient(-45, -230, 45, -100);
  shirt.addColorStop(0, '#a9cdf5');
  shirt.addColorStop(1, '#4d76a8');
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.roundRect(-46, -235, 92, 135, 26);
  ctx.fill();
  // Head: skin, hair, eyes.
  ctx.fillStyle = '#e6b794';
  ctx.beginPath();
  ctx.ellipse(0, -275, 31, 37, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2a1d17';
  ctx.beginPath();
  ctx.ellipse(0, -295, 33, 24, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1b1b1b';
  ctx.beginPath();
  ctx.arc(-11, -274, 3.2, 0, Math.PI * 2);
  ctx.arc(11, -274, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#8a4a3b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, -262, 9, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.restore();
}
