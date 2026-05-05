export type ServiceEvent =
  | { type: "drawing_detected"; bbox: [number, number, number, number]; progress?: number }
  | { type: "drawing_captured"; id: string; url: string; palette: string[]; w: number; h: number }
  | { type: "hand_gesture"; gesture: string; hand: "L" | "R"; landmarks: number[][] }
  | { type: "joystick"; axes: number[]; buttons: boolean[] }
  | { type: "serial_status"; connected: boolean }
  | { type: "drawings_list"; items: { id: string; url: string; palette: string[] }[] };

type Handler = (ev: ServiceEvent) => void;

let ws: WebSocket | null = null;
let handlers: Handler[] = [];
let url = "ws://127.0.0.1:8765/ws";

export function connect(onEvent: Handler, override?: string) {
  if (override) url = override;
  handlers.push(onEvent);
  open();
}

function open() {
  ws = new WebSocket(url);
  ws.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data) as ServiceEvent;
      handlers.forEach((h) => h(ev));
    } catch {}
  };
  ws.onclose = () => setTimeout(open, 1000);
  ws.onerror = () => ws?.close();
}

export function send(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
