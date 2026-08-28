// 容器宽度测量（ResizeObserver）：图表等自绘组件用于响应式布局。
// 初次渲染无测量值 → fallback 返回 0，调用方自行兜底。
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export function useContainerWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
