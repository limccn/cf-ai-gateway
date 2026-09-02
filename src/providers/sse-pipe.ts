// 统一 SSE 帧层（08-31-1102 性能修复 R2.4）：单次 TextDecoder + 帧排空 + 每帧恰好一次解析。
// 三条流式协议路径（P1 openai 透传 / P2 anthropic 入站 / P3 responses）共用本层，
// 消除各转换器独立 decode/parse 与 settle 的全量重扫（O(n²)）。
//
// 帧切分：LF `\n\n` 与 CRLF `\r\n\r\n` 取最早边界，分隔符原字节保留
// （与 maskModelInStream 的既有语义一致，抽为公共函数避免漂移）。
// 事件解析：event:/data: 行、`\r` 行尾剥离、注释行忽略（与 parseSseStream 同语义）；
// data 的 JSON 解析**容错**——非 JSON 帧 data 保留原字符串（由消费方守卫跳过），
// 上游异常帧不再打断整条流；parseSseStream 的严格模式由 sse.ts 以 { strict: true } 保留。

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * 从累积缓冲中切出最早完成的帧（LF/CRLF 双分隔，取最早边界；分隔符原字节返回）。
 * 缓冲不足（无完整帧）返回 null。
 */
export function splitNextFrame(
  buffer: string,
): { block: string; sep: string; rest: string } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  let index = -1;
  let sepLen = 0;
  if (lfIndex !== -1 && (crlfIndex === -1 || lfIndex < crlfIndex)) {
    index = lfIndex;
    sepLen = 2;
  } else if (crlfIndex !== -1) {
    index = crlfIndex;
    sepLen = 4;
  }
  if (index === -1) {
    return null;
  }
  return {
    block: buffer.slice(0, index),
    sep: buffer.slice(index, index + sepLen),
    rest: buffer.slice(index + sepLen),
  };
}

/**
 * 解析事件块（多个 data: 行按 SSE 规范用 `\n` 连接）。
 * data 为空 / `[DONE]` → data:null（非 JSON，不可 parse）；JSON 解析失败：
 * strict 模式抛出（parseSseStream 语义），否则 data 保留原字符串（容错语义，
 * 转换器以 `typeof data !== "object"` 守卫跳过）。
 */
export function parseFrameBlock(
  block: string,
  opts: { strict?: boolean } = {},
): SseEvent {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // 注释行（: ...）与空行忽略
  }
  const data = dataLines.join("\n");
  if (data.length === 0 || data === "[DONE]") {
    return { event, data: null };
  }
  try {
    return { event, data: JSON.parse(data) };
  } catch (error) {
    if (opts.strict === true) {
      throw error;
    }
    return { event, data };
  }
}

/** 每帧消费回调（转换器状态机）：false = 停止投喂后续事件（输出已终态）。
 * pump 仍继续排空上游并观察事件（结算旁路不受影响）。 */
export type SseFrameConsumer = (
  event: SseEvent,
  controller: ReadableStreamDefaultController<Uint8Array>,
) => boolean;

/** 事件消费转换（转换路径）：消费帧并 enqueue 输出字节；可选错误/结束钩子。 */
export interface SseFrameTransform {
  /** 逐帧消费；返回 false 停止投喂（输出已终态）。 */
  consume: SseFrameConsumer;
  /** 上游读错误：输出错误事件（如 Anthropic error 帧）；定义后视为已处理（正常关闭）。 */
  onError?: (
    error: unknown,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => void;
  /** 正常流结束（尾帧 flush 后、未停止投喂时调用）：终态兜底（[DONE] / message_stop 等）。 */
  onEnd?: (controller: ReadableStreamDefaultController<Uint8Array>) => void;
}

export interface SsePipeOptions {
  /** 每帧观察钩子（结算 usage 检测等副作用；与输出无关，consume 之前调用）。 */
  onEvent?: (event: SseEvent) => void;
  /** 事件消费转换（缺省 = 原始字节透传，观察不影响输出字节）。 */
  transform?: SseFrameTransform;
  /** 流终止回调（正常结束 / 上游错误 / 输出取消，恰好一次；await 后才 close/error）。 */
  onTerminate?: (
    kind: "end" | "error" | "cancel",
    detail?: unknown,
  ) => void | Promise<void>;
  /** 流空闲超时（ms，U7）：两次上游 chunk 的最大间隔；触发 → 取消上游读并报
   *  idle-timeout 错误（TTFB 超时只保护响应头前，流中途停顿由本层兜底）。
   *  缺省 = 无超时。 */
  idleTimeoutMs?: number;
}

/**
 * 统一 SSE 帧管线：单次 TextDecoder + 帧排空（LF/CRLF 双分隔）+ 每帧恰好一次解析。
 * - transform 缺省：输出 = 上游原始字节（透传路径字节原样，零重编码，观察为旁路）。
 * - transform 提供：输出 = 消费回调 enqueue 的字节；回调返回 false 后停止投喂，
 *   但排空与观察继续（结算仍需看到流结束）。
 * - 流结束：尾帧 flush → onEnd（未停止投喂时）→ onTerminate → close；
 *   上游读错误：onError（定义了视为已处理，正常关闭）否则 error 输出；
 *   输出取消：cancel 钩子（onTerminate("cancel")）。
 */
export function pipeSseStream(
  input: ReadableStream<Uint8Array>,
  opts: SsePipeOptions = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  // H12：reader 提升到构造作用域（cancel 钩子需访问；输入流在构造后立即被本管线独占，
  // 调用方均为新构造流，无已锁定竞态）
  const reader = input.getReader();
  let buffer = "";
  let stopped = false;
  let terminated = false;
  let idleFired = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  async function terminate(
    kind: "end" | "error" | "cancel",
    detail?: unknown,
  ): Promise<void> {
    if (terminated) {
      return;
    }
    terminated = true;
    if (opts.onTerminate !== undefined) {
      await opts.onTerminate(kind, detail);
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let endKind: "end" | "error" = "end";
      let endDetail: unknown;
      try {
        while (true) {
          // U7：空闲超时（每 chunk 重置）。触发 → reader.cancel 停止上游拉取
          //（pending read 转为 done → 循环退出 → terminate 结算），同时以
          // idle-timeout 错误结束输出（下游 read 拒绝；error 优先于 close）
          if (opts.idleTimeoutMs !== undefined) {
            idleTimer = setTimeout(() => {
              idleFired = true;
              void reader.cancel(new Error("idle timeout")).catch(() => {});
              try {
                controller.error(new Error(`upstream idle timeout after ${opts.idleTimeoutMs}ms`));
              } catch {
                // 输出已取消/关闭，忽略
              }
            }, opts.idleTimeoutMs);
          }
          let done: boolean;
          let value: Uint8Array | undefined;
          try {
            const read = await reader.read();
            done = read.done;
            value = read.value;
          } finally {
            clearIdleTimer();
          }
          if (done) {
            break;
          }
          // done=false 时 value 必有值（ReadableStream 契约）；undefined 分支为不可达防御
          if (value === undefined) {
            break;
          }
          const chunk = value;
          if (opts.transform === undefined) {
            // 透传模式：输出原始字节（settle/观察为旁路，不参与输出）
            controller.enqueue(chunk);
          }
          buffer += decoder.decode(chunk, { stream: true });
          // 帧排空：一 chunk 可含多帧，一帧可跨多 chunk
          for (;;) {
            const frame = splitNextFrame(buffer);
            if (frame === null) {
              break;
            }
            buffer = frame.rest;
            if (frame.block.trim().length === 0) {
              // 空块（连续空行分隔符）不产生事件（与 parseSseStream 同语义）
              continue;
            }
            const event = parseFrameBlock(frame.block);
            opts.onEvent?.(event);
            if (opts.transform !== undefined && !stopped) {
              stopped = !opts.transform.consume(event, controller);
            }
          }
        }
        // 尾帧 flush（与 parseSseStream 一致：残留完整块也输出；stopped 后不投喂）
        const remaining = buffer.trim();
        if (remaining.length > 0) {
          const event = parseFrameBlock(remaining);
          opts.onEvent?.(event);
          if (opts.transform !== undefined && !stopped) {
            stopped = !opts.transform.consume(event, controller);
          }
        }
        if (opts.transform !== undefined && !stopped) {
          opts.transform.onEnd?.(controller);
        }
      } catch (error) {
        if (idleFired) {
          // 空闲超时：不输出错误帧（消费方已停投喂），直接以 idle-timeout 错误结束
          endDetail = new Error(`upstream idle timeout after ${opts.idleTimeoutMs}ms`);
          endKind = "error";
        } else if (opts.transform?.onError !== undefined) {
          try {
            opts.transform.onError(error, controller);
            endKind = "end"; // 消费方已输出错误事件 → 正常关闭
            endDetail = undefined;
          } catch {
            endKind = "error";
          }
        } else {
          endKind = "error";
        }
      } finally {
        reader.releaseLock();
        await terminate(endKind, endDetail);
        try {
          if (endKind === "error") {
            controller.error(endDetail);
          } else {
            controller.close();
          }
        } catch {
          // 输出已取消，忽略
        }
      }
    },
    async cancel(reason) {
      clearIdleTimer();
      await terminate("cancel", reason);
      // H12：cancel 传播 —— 客户端断开后释放上游 reader（pending read 转 done，
      // 拉流循环退出），不再持续拉取+缓冲整个剩余响应（上游成本与内存同时释放）；
      // 输入侧也是本管线的输出（wrapStreamWithSettlement 链）→ cancel 沿链上溯
      // 直至真正释放上游 HTTP body。
      await reader.cancel(reason).catch(() => {});
    },
  });
}
