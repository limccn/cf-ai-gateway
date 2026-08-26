// SSR-safe 模式（spec authentication.md：isMounted 防水合错误）。
// 本项目为纯 SPA，无服务端渲染；该 hook 仍按 spec 强制要求用于
// 认证组件/页面，确保任何渲染环境（含未来引入 SSR 时）行为一致。
import { useEffect, useState } from "react";

export function useMounted(): boolean {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  return isMounted;
}
