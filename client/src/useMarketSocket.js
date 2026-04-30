import { useEffect, useRef, useState } from "react";

// Maintains a single WebSocket connection to the server, reconnects on drop,
// and dispatches messages to subscribed handlers.
export function useMarketSocket(url) {
  const [status, setStatus] = useState("connecting");
  const [hello, setHello] = useState(null);
  const handlersRef = useRef(new Set());
  const wsRef = useRef(null);
  const reconnectRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const connect = () => {
      if (cancelled) return;
      setStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectRef.current = 0;
        setStatus("open");
      };
      ws.onclose = () => {
        setStatus("closed");
        const delay = Math.min(1000 * 2 ** reconnectRef.current++, 8000);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "hello") setHello(msg);
        for (const fn of handlersRef.current) fn(msg);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (wsRef.current) wsRef.current.close();
    };
  }, [url]);

  const send = (obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const subscribe = (fn) => {
    handlersRef.current.add(fn);
    return () => handlersRef.current.delete(fn);
  };

  return { status, hello, send, subscribe };
}
