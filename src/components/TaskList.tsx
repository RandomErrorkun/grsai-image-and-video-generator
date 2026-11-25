/**
 * 任务列表和任务卡片（对应 ui/components/task_widget.py）。
 * 卡片的状态在 TaskList 状态仓里，这里只负责画。
 * 源项目里写死英文的文字（Retry、Regenerate New Image）照旧保持英文。
 */
import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Button, Tooltip } from "@fluentui/react-components";
import { ArrowSync20Regular } from "@fluentui/react-icons";
import { useTaskCards } from "../hooks/useTaskList";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { MediaThumb } from "./MediaThumb";
import { MODERATION_FAILURE_REASONS, taskStatusText, type TaskCard, type TaskList as TaskListModel } from "../state/taskList";
import "./TaskList.css";

interface TaskListViewProps {
  list: TaskListModel;
  /** 重新生成要按页面此刻的自动重试开关建新卡片，所以交回给页面处理。 */
  onRegenerate(card: TaskCard): void;
  className?: string;
}

export function TaskListView({ list, onRegenerate, className }: TaskListViewProps) {
  const cards = useTaskCards(list);
  return (
    <div className={className ? `task-list ${className}` : "task-list"} role="list">
      {cards.map((card) => (
        <TaskCardView
          key={card.index}
          card={card}
          onRetry={() => list.retry(card.index)}
          onRegenerate={() => onRegenerate(card)}
        />
      ))}
    </div>
  );
}

const RING_SIZE = 50;
const RING_STROKE = 4;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 进度环：一圈强调色的弧，中间是百分比。 */
function ProgressRing({ value, label }: { value: number; label: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(value || 0)));
  return (
    <svg
      className="task-card__ring"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      role="img"
      aria-label={label}
    >
      <circle className="task-card__ring-track" cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} />
      <circle
        className="task-card__ring-value"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        strokeDasharray={`${(percent / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
      />
      <text className="task-card__ring-text" x={RING_SIZE / 2} y={RING_SIZE / 2} textAnchor="middle" dominantBaseline="central">
        {percent}%
      </text>
    </svg>
  );
}

/** 成功后的结果按钮：图像任务显示缩略图，视频任务显示图标；点一下用系统程序打开，右键可以重新生成。 */
function ResultButton({ card, onRegenerate }: { card: TaskCard; onRegenerate: () => void }) {
  // Tauri 里本地文件要先放行才读得到，放行之后再画缩略图
  const [ready, setReady] = useState(!platform.isTauri);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const path = card.resultPath;

  useEffect(() => {
    if (!platform.isTauri || !path) {
      setReady(true);
      return;
    }
    let cancelled = false;
    const settle = () => {
      if (!cancelled) setReady(true);
    };
    runAsync(platform.media.allow([path]).then(settle, settle));
    return () => {
      cancelled = true;
    };
  }, [path]);

  // 点到别处或者按 Esc 就收起右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const openResult = () => {
    if (path) runAsync(platform.opener.openPath(path));
  };
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <div className="task-card__result-wrap">
      <button
        type="button"
        className="task-card__result"
        aria-label={card.mediaType === "video" ? "Play video" : "Open result"}
        onClick={openResult}
        onContextMenu={openMenu}
      >
        {ready && path ? (
          <MediaThumb
            path={path}
            className="task-card__thumbnail"
            alt={card.mediaType === "video" ? "Play video" : "Open result"}
          />
        ) : null}
      </button>
      {menu ? (
        <div className="task-card__menu" role="menu" style={{ left: menu.x, top: menu.y } as CSSProperties}>
          <button
            type="button"
            role="menuitem"
            className="task-card__menu-item"
            onClick={() => {
              setMenu(null);
              onRegenerate();
            }}
          >
            Regenerate New Image
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface TaskCardViewProps {
  card: TaskCard;
  onRetry(): void;
  onRegenerate(): void;
}

function TaskCardView({ card, onRetry, onRegenerate }: TaskCardViewProps) {
  const t = useTr();
  const tone = card.status === "succeeded" ? "success" : card.status === "failed" ? "failed" : "normal";
  const isViolation =
    card.status === "failed" && card.failureReason !== null && MODERATION_FAILURE_REASONS.has(card.failureReason);
  const tagKind =
    card.status === "succeeded"
      ? "succeeded"
      : isViolation
        ? "violation"
        : card.status === "failed"
          ? "failed"
          : "running";
  const statusText = taskStatusText(card, t);
  const lineText =
    card.status === "failed" && card.delivery === "unknown"
      ? `${statusText} — ${t("task.delivery_unknown")}`
      : statusText;
  const reason = card.error ?? "";

  return (
    <div className={`task-card task-card--${tone}`} role="listitem" title={card.prompt}>
      <span className="task-card__index">#{card.index}</span>
      <div className="task-card__stack">
        {card.status === "succeeded" ? (
          <ResultButton card={card} onRegenerate={onRegenerate} />
        ) : card.status === "failed" ? (
          <Tooltip content={`Failed: ${reason}. Click to retry.`} relationship="label">
            <Button
              appearance="transparent"
              className="task-card__stack-button"
              icon={<ArrowSync20Regular className="task-card__retry-icon" />}
              aria-label="Retry"
              onClick={onRetry}
            />
          </Tooltip>
        ) : (
          <ProgressRing value={card.progress ?? 0} label={`Status: ${statusText}`} />
        )}
      </div>
      <div className="task-card__body">
        <span className={`task-card__tag task-card__tag--${tagKind}`}>{t(`task.tag.${tagKind}`)}</span>
        <span
          className="task-card__status"
          title={card.taskId ? `Task ${card.taskId} — ${lineText}` : lineText}
        >
          {lineText}
        </span>
      </div>
    </div>
  );
}
