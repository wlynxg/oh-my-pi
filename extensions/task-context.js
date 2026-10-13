import { VERSION } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GOAL_LIMIT, STEP_LIMIT, TASK_VERSION, registerTaskContext } from "./task-context/controller.js";

const TASK_FIELDS = {
  goal: Type.String({ minLength: 1, maxLength: GOAL_LIMIT, description: "Concrete task goal across turns, never just deploy/execute/continue" }),
  step: Type.String({ minLength: 1, maxLength: STEP_LIMIT, description: "Current action or decision still needed, not an acceptance claim" }),
};

export default function taskContextExtension(pi) {
  const [major, minor] = VERSION.split(".").map(Number);
  if (major < 1 || (major === 1 && minor < 2)) throw new Error("任务摘要扩展要求 Pi 1.2.0 或更新版本。");
  registerTaskContext(pi, {
    parameters: Type.Object(TASK_FIELDS, { additionalProperties: false }),
    outputSchema: Type.Object({ version: Type.Literal(TASK_VERSION), ...TASK_FIELDS }, { additionalProperties: false }),
    text: value => new Text(value, 0, 0),
    // 复用宿主的显示宽度计算，窄窗口也保持两行且不截坏中文字符。
    widget: lines => () => ({ render: width => lines.map(line => truncateToWidth(line, width)), invalidate() {} }),
  });
}
