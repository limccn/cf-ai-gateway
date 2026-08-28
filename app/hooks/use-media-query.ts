// 响应式断点 hook：SSR 安全（客户端首帧用默认值，effect 后与实际视口同步）。
import { useEffect, useState } from "react";

/** 视口是否小于 Tailwind sm 断点（<640px，即手机端）。 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isMobile;
}
