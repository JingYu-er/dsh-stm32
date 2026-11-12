/**
 * 监视自动采样的接线：录制器 → 真实采样 → 通道事件。
 *
 * 采样本身沿用 `debugSessions.sampleWatches`（目标在跑就先拦停、读完按原状态放回），
 * 这里只负责「什么时候采」和「怎么发」。`channel:watch` 的形状与 stm32_watch
 * 的 sample 一致，面板的历史曲线不用改。
 */

import { createWatchRecorder } from "./watch-recorder.js";
import { debugSessions } from "./debug-session.js";
import { emitChannel } from "./channels.js";
import type { WatchSample } from "./debug-session.js";

/** 样本 → 面板里的一行文本（与 stm32_watch sample 的写法一致）。 */
export function recordLines(samples: WatchSample[]): string[] {
  return samples.map((sample) =>
    sample.ok
      ? sample.expression + " = " + sample.value + (sample.delta === "" ? "" : "（" + sample.delta + "）")
      : sample.expression + "：" + sample.error,
  );
}

/** 进程内唯一的录制器：HTTP 接口与 dispose 都拿同一个。 */
export const watchRecorder = createWatchRecorder({
  sample: async () => {
    const report = await debugSessions.sampleWatches({});
    return { ok: report.ok, samples: report.samples, errors: report.errors };
  },
  emit: (samples) => {
    emitChannel({
      channel: "watch",
      lines: recordLines(samples),
      meta: {
        action: "record",
        samples: samples.map((sample) => ({
          expression: sample.expression,
          value: sample.value,
          delta: sample.delta,
          ok: sample.ok,
        })),
      },
    });
  },
  now: () => Date.now(),
});
