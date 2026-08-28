// 容器宽度测量（ResizeObserver）：图表等自绘组件用于响应式布局。
// 初次渲染无测量值 → 返回 0，调用方自行兜底。
// 2026-08-28 修复：原 useLayoutEffect（空依赖）只在 mount 时执行一次，调用方
// 首渲染若条件分支未挂载测量节点（如 BarChart 数据 loading 时走空态），
// ref.current 为 null 直接 return → 之后数据到达再渲染也永不测量 → 永远用兜底宽。
// 改为 callback ref（React 19 ref cleanup）：节点无论何时挂载，一出现即测量并 observe。
import { useCallback, useState, type RefCallback } from "react";

export function useContainerWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [width, setWidth] = useState(0);

  const ref = useCallback((node: T | null) => {
    if (!node) {
      return;
    }
    const update = () => setWidth(node.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    // React 19 支持 callback ref 返回清理函数：节点卸载时断开 observer
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
