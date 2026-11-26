/**
 * 历史页（对应 ui/history_page.py）。
 *
 * 外壳里五个页面常驻、只隐藏不卸载，所以每次重新露面都要重读一遍，对应源项目的 showEvent。
 * 「重新生成」只发请求，切页和回填由外壳与目标页面完成。
 * 确认框和详情用应用内的 Dialog；源项目用的是原生对话框和提示框。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Tooltip,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  ArrowDownload20Regular,
  ArrowLeft20Regular,
  ArrowRight20Regular,
  ArrowSync20Regular,
  CheckmarkSquare20Regular,
  Delete20Regular,
  Dismiss20Regular,
  Folder20Regular,
  SelectAllOn20Regular,
  Video20Regular,
} from "@fluentui/react-icons";
import { DEFAULT_CONFIG } from "../core/config";
import type { HistoryTask } from "../core/history";
import { pyStr } from "../core/py";
import { notice } from "../components/Notice";
import { useConfigValue } from "../hooks/useConfigValue";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { MediaThumb } from "../components/MediaThumb";
import { runAsync } from "../platform/async";
import { historyRefetcher, type RefetchOutcome } from "../state/historyRefetch";
import { openPreview } from "../state/preview";
import { requestRestore } from "../state/restore";
import { backfillUsageLedger, openHistory, subscribeHistoryChanged } from "../state/services";
import { comicTasks, generatorTasks, isTaskIdActive, videoTasks } from "../state/taskLists";
import { computeResultArtifacts, verifyHistoryResultFile } from "../state/thumbnail";
import {
  CLEAR_ACTIONS,
  CLEAR_ORDER,
  capitalize,
  clampPage,
  confirmTextKey,
  errorPreview,
  hasDetailValue,
  hasResult,
  isVideoResult,
  modelLine,
  pageCount,
  pageSizeOf,
  statusTone,
  type ClearKind,
  type StatusTone,
} from "./historyView";
import "./HistoryPage.css";

/** 缩略图离视野还有这么远就开始取图。 */
const THUMBNAIL_MARGIN = "300px";

/** 详情里的一行「标签: 值」。文字与源项目一样写死英文。 */
function DetailRow({ label, children, tone }: { label: string; children: ReactNode; tone?: StatusTone }) {
  const valueClass = tone ? `history-details__value history-details__value--${tone}` : "history-details__value";
  return (
    <div className="history-details__row">
      <span className="history-details__label">{label}</span>
      <span className={valueClass}>{children}</span>
    </div>
  );
}

function DetailsContent({ task }: { task: HistoryTask }) {
  const error = errorPreview(task.error_message);
  return (
    <>
      <section className="history-details__section">
        <h4 className="history-details__title">📝 Prompt</h4>
        <div className="history-details__prompt">{task.prompt}</div>
      </section>
      <hr className="history-details__rule" />
      <section className="history-details__section">
        <h4 className="history-details__title">⚙️ Configuration</h4>
        <DetailRow label="Model:">{pyStr(task.model)}</DetailRow>
        <DetailRow label="Size:">{pyStr(task.image_size)}</DetailRow>
        <DetailRow label="Aspect Ratio:">{pyStr(task.aspect_ratio)}</DetailRow>
        {hasDetailValue(task.duration) ? <DetailRow label="Duration:">{pyStr(task.duration)}s</DetailRow> : null}
        {hasDetailValue(task.seed) ? <DetailRow label="Seed:">{pyStr(task.seed)}</DetailRow> : null}
      </section>
      <section className="history-details__section">
        <h4 className="history-details__title">📊 Status</h4>
        <DetailRow label="Status:" tone={statusTone(task.status)}>
          {capitalize(task.status)}
        </DetailRow>
        <DetailRow label="Created At:">{pyStr(task.created_at)}</DetailRow>
        <DetailRow label="Task ID:">
          <span className="history-details__mono">{task.id}</span>
        </DetailRow>
      </section>
      {/* 与源项目一致：只有失败任务列出错误信息，违规任务不列 */}
      {task.status === "failed" ? (
        <section className="history-details__section">
          <h4 className="history-details__title">❌ Error Information</h4>
          <DetailRow label="Failure Reason:" tone="failed">
            {pyStr(task.failure_reason)}
          </DetailRow>
          {error ? (
            <>
              <div className="history-details__row">
                <span className="history-details__label">Details:</span>
              </div>
              <div className="history-details__error">{error.text}</div>
              {error.truncated ? (
                <p className="history-details__note">Error message truncated. Full message available in logs.</p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

/** 正在为老历史记录补齐缩略图/SHA-256 的任务集合，防止重复计算。 */
const backfillingIds = new Set<string>();

/** 后台为尚无缓存缩略图或 SHA-256 的历史成功记录补齐并写入 SQLite；不打扰界面交互。 */
async function backfillArtifacts(task: HistoryTask): Promise<void> {
  if (task.status !== "succeeded" || !task.result_path) return;
  if (task.thumbnail && task.result_sha256) return;
  if (backfillingIds.has(task.id)) return;
  backfillingIds.add(task.id);
  try {
    const check = await verifyHistoryResultFile(task);
    if (!check.ok) return;
    const artifacts = await computeResultArtifacts(check.path);
    const patch: { thumbnail?: string; resultSha256?: string } = {};
    if (!task.thumbnail && artifacts.thumbnail) patch.thumbnail = artifacts.thumbnail;
    if (!task.result_sha256 && artifacts.resultSha256) patch.resultSha256 = artifacts.resultSha256;
    if (patch.thumbnail || patch.resultSha256) {
      const history = await openHistory();
      await history.updateTask(task.id, task.status, patch);
    }
  } catch {
    // 静默兜底
  } finally {
    backfillingIds.delete(task.id);
  }
}

interface ThumbnailProps {
  task: HistoryTask;
  onOpenResult(task: HistoryTask): void;
}

/**
 * 缩略图位：
 * - 若 SQLite 里已存低画质缩略图（task.thumbnail），无论原文件是否被删/移都直接显示小图；
 * - 若老记录尚无缓存缩略图，则从本地原文件渲染并在后台自动回填缩略图与 SHA-256 到库里；
 * - 点击缩略图时校验原文件存在且 SHA-256 一致后才打开，缺失或被同名替换时弹提示。
 */
function Thumbnail({ task, onOpenResult }: ThumbnailProps) {
  const t = useTr();
  const host = useRef<HTMLDivElement>(null);
  const path = task.result_path;
  const video = isVideoResult(path);
  const cachedThumb = task.thumbnail;
  // checking 期间先照常显示占位，查完文件不在才换成「无图片」
  const [presence, setPresence] = useState<"checking" | "present" | "missing">(cachedThumb ? "present" : "checking");
  const [near, setNear] = useState(false);
  const [allowed, setAllowed] = useState(Boolean(cachedThumb));
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    // 已有库内缩略图：无需碰磁盘即可立刻展示；若缺 SHA-256 则后台尝试补齐
    if (cachedThumb) {
      setPresence("present");
      setAllowed(true);
      setBroken(false);
      if (path && !task.result_sha256) runAsync(backfillArtifacts(task));
      return;
    }
    if (!path) {
      setPresence("missing");
      return;
    }
    let cancelled = false;
    setPresence("checking");
    setAllowed(false);
    setBroken(false);
    const settle = (exists: boolean) => {
      if (!cancelled) {
        setAllowed(true);
        setPresence(exists ? "present" : "missing");
        if (exists) runAsync(backfillArtifacts(task));
      }
    };
    // 先放行再查存在：若结果文件在程序目录之外的自定义输出目录里，未放行前 exists 会被权限作用域拦截
    runAsync(
      platform.media
        .allow([path])
        .catch(() => {})
        .then(() => platform.fs.exists(path))
        .then(settle, () => settle(false)),
    );
    return () => {
      cancelled = true;
    };
  }, [cachedThumb, path, task.id, task.result_sha256]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: THUMBNAIL_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const noImage = <span className="history-item__thumb-text">{t("history.no_image")}</span>;
  let content: ReactNode;
  if (cachedThumb && !broken) {
    content = <img src={cachedThumb} alt="" className="history-item__image" onError={() => setBroken(true)} />;
  } else if (presence === "missing" || !path) {
    content = noImage;
  } else if (presence === "present" && near && allowed) {
    // 老记录无缓存缩略图时现场渲染首帧
    content = broken ? noImage : <MediaThumb path={path} className="history-item__image" onBroken={() => setBroken(true)} />;
  } else {
    content = video ? (
      <Video20Regular className="history-item__video" />
    ) : (
      <span className="history-item__thumb-text">...</span>
    );
  }

  const clickable = Boolean(path) && (Boolean(cachedThumb) || presence === "present");

  return (
    <div ref={host} className="history-item__thumb">
      {content}
      {clickable ? (
        video ? (
          <Tooltip content={t("history.play_video")} relationship="label">
            <button
              type="button"
              className="history-item__thumb-hit"
              onClick={() => onOpenResult(task)}
            />
          </Tooltip>
        ) : (
          <button
            type="button"
            className="history-item__thumb-hit"
            aria-label={t("history.open_result")}
            onClick={() => onOpenResult(task)}
          />
        )
      ) : null}
    </div>
  );
}

interface HistoryItemProps {
  task: HistoryTask;
  refetching: boolean;
  tracking: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect(taskId: string): void;
  onContextMenu(event: MouseEvent<HTMLElement>, task: HistoryTask): void;
  onRefetch(task: HistoryTask): void;
  onOpenResult(task: HistoryTask): void;
  onOpenFolder(task: HistoryTask): void;
  onShowDetails(task: HistoryTask): void;
}

function HistoryItem({
  task,
  refetching,
  tracking,
  selectMode,
  selected,
  onToggleSelect,
  onContextMenu,
  onRefetch,
  onOpenResult,
  onOpenFolder,
  onShowDetails,
}: HistoryItemProps) {
  const t = useTr();
  const path = task.result_path;
  const result = hasResult(task);
  const showThumb = Boolean(task.thumbnail) || (result && Boolean(path));
  const tone = statusTone(task.status);

  return (
    <article
      className={selected ? "history-item history-item--selected" : "history-item"}
      role="listitem"
      onContextMenu={(event) => onContextMenu(event, task)}
    >
      {selectMode ? (
        <div className="history-item__check">
          <Checkbox
            checked={selected}
            aria-label={task.id}
            onChange={() => onToggleSelect(task.id)}
          />
        </div>
      ) : null}
      {showThumb ? (
        <Thumbnail task={task} onOpenResult={onOpenResult} />
      ) : (
        <div className="history-item__thumb">
          <span className="history-item__thumb-text">{t("history.no_image")}</span>
        </div>
      )}
      <div className="history-item__info">
        <span className="history-item__line">
          <Tooltip content={t("history.prompt_tooltip")} relationship="description">
            <button type="button" className="history-item__prompt" onClick={() => onShowDetails(task)}>
              {task.prompt}
            </button>
          </Tooltip>
        </span>
        <span className="history-item__line">
          <span className="history-item__model">{modelLine(task)}</span>
        </span>
        <span className="history-item__line">
          <span className="history-item__time">{task.created_at}</span>
        </span>
      </div>
      <div className="history-item__side">
        <div className="history-item__status-row">
          {tracking ? <span className="history-item__tracking">{t("history.tracking")}</span> : null}
          <span className={`history-item__status history-item__status--${tone}`}>{capitalize(task.status)}</span>
        </div>
        <div className="history-item__actions">
          <Tooltip content={t("history.refetch_tooltip")} relationship="description">
            <Button
              appearance="transparent"
              className="history__button"
              icon={<ArrowDownload20Regular />}
              disabled={refetching}
              onClick={() => onRefetch(task)}
            >
              {t("history.refetch")}
            </Button>
          </Tooltip>
          <Tooltip content={t("history.regenerate")} relationship="description">
            <Button
              appearance="transparent"
              className="history__button"
              icon={<ArrowSync20Regular />}
              onClick={() => requestRestore(task)}
            >
              {t("history.regenerate")}
            </Button>
          </Tooltip>
          {result && path ? (
            <Tooltip content={t("history.open_folder")} relationship="description">
              <Button appearance="transparent" className="history__button" icon={<Folder20Regular />} onClick={() => onOpenFolder(task)}>
                {t("history.open_folder")}
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </article>
  );
}

interface PageData {
  tasks: HistoryTask[];
  page: number;
  totalPages: number;
}

interface ConfirmState {
  kind: ClearKind;
  /** 清空全部要连着确认两次。 */
  round: number;
}

interface DeleteConfirmState {
  mode: "single" | "page" | "selected";
  ids: string[];
}

interface ContextMenuState {
  x: number;
  y: number;
  task: HistoryTask;
}

export default function HistoryPage() {
  const t = useTr();
  const pageSize = pageSizeOf(useConfigValue("history_items_per_page", DEFAULT_CONFIG.history_items_per_page));
  const [data, setData] = useState<PageData>({ tasks: [], page: 1, totalPages: 1 });
  // 开关和内容分开存：关掉时内容要留到淡出动画放完，不能先空掉
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [detailsTask, setDetailsTask] = useState<HistoryTask | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pageRefetching, setPageRefetching] = useState(false);
  // 用来在再获取在途状态或任务列表活跃状态变化时触发重绘
  const [, setSyncTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const noButtonRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const visibleRef = useRef(false);
  // 当前页码和读取凭证放在 ref 里，事件处理函数和异步回调拿到的都是最新值
  const pageRef = useRef(1);
  const loadToken = useRef(0);

  const load = useCallback(
    async (page: number, options: { keepScroll?: boolean } = {}) => {
      const token = ++loadToken.current;
      const history = await openHistory();
      const totalPages = pageCount(await history.getTaskCount(), pageSize);
      const target = clampPage(page, totalPages);
      const tasks = await history.getTasksPage(target, pageSize);
      // 读到一半又被另一次读取超过，这一次就作废
      if (token !== loadToken.current) return;
      pageRef.current = target;
      setData({ tasks, page: target, totalPages });
      // 只保留当前页仍存在的已选 ID，避免误删不可见页的记录
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const present = new Set(tasks.map((task) => task.id));
        const next = new Set([...prev].filter((id) => present.has(id)));
        return next.size === prev.size ? prev : next;
      });
      // 与源项目重建列表一致：翻页、手动刷新后回到顶部；后台任务变更触发的原地刷新保持滚动位置
      if (!options.keepScroll) listRef.current?.scrollTo(0, 0);
    },
    [pageSize],
  );

  // 每次露面、每页数量变了都重读，对应源项目的 showEvent。
  // 外壳把藏着的页面 display:none，从藏到露时观察器会报一次。
  useEffect(() => {
    const element = rootRef.current;
    const reload = () => runAsync(load(pageRef.current));
    if (!element || typeof IntersectionObserver === "undefined") {
      visibleRef.current = true;
      reload();
      return;
    }
    let shown = false;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      visibleRef.current = visible;
      if (visible && !shown) reload();
      shown = visible;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [load]);

  // 订阅在途再获取、任务列表活跃状态和历史库变更，保持按钮状态与列表实时同步
  useEffect(() => {
    const bump = () => setSyncTick((n) => n + 1);
    const unsubs = [
      historyRefetcher.subscribe(bump),
      generatorTasks.subscribe(bump),
      videoTasks.subscribe(bump),
      comicTasks.subscribe(bump),
      subscribeHistoryChanged(() => {
        if (visibleRef.current) runAsync(load(pageRef.current, { keepScroll: true }));
      }),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [load]);

  const showPage = (page: number) => {
    pageRef.current = page;
    setSelectedIds(new Set());
    setContextMenu(null);
    runAsync(load(page));
  };

  // 右键菜单在外部点击、滚动、窗口失焦或按 Esc 时自动关闭
  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    const listEl = listRef.current;
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    listEl?.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      listEl?.removeEventListener("scroll", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (deleteConfirmOpen) deleteCancelRef.current?.focus();
  }, [deleteConfirmOpen]);

  const toggleSelect = (taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleSelectMode = () => {
    setSelectMode((prev) => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
    setContextMenu(null);
  };

  const allOnPageSelected = data.tasks.length > 0 && data.tasks.every((task) => selectedIds.has(task.id));

  const toggleSelectAllOnPage = () => {
    if (allOnPageSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.tasks.map((task) => task.id)));
    }
  };

  const openContextMenu = (event: MouseEvent<HTMLElement>, task: HistoryTask) => {
    event.preventDefault();
    const menuWidth = 176;
    const menuHeight = 46;
    const maxX = Math.max(8, window.innerWidth - menuWidth - 8);
    const maxY = Math.max(8, window.innerHeight - menuHeight - 8);
    setContextMenu({
      x: Math.min(Math.max(8, event.clientX), maxX),
      y: Math.min(Math.max(8, event.clientY), maxY),
      task,
    });
  };

  const requestDeleteConfirm = (mode: DeleteConfirmState["mode"], ids: string[]) => {
    if (ids.length === 0) return;
    setContextMenu(null);
    setDeleteConfirm({ mode, ids });
    setDeleteConfirmOpen(true);
  };

  const executeDelete = async (ids: string[]) => {
    // 先把尚未同步进用量台账的老记录补录一份，确保删除历史不会丢失用量统计
    await backfillUsageLedger().catch(() => {});
    const history = await openHistory();
    const deleted = await history.deleteTasks(ids);
    setSelectedIds(new Set());
    await load(pageRef.current, { keepScroll: true });
    notice("success", t("common.success"), t("history.clear_done", { count: deleted }));
  };

  const announceRefetch = (outcome: RefetchOutcome) => {
    switch (outcome.kind) {
      case "in_flight":
      case "skipped_succeeded":
        return;
      case "already_tracking":
        notice("info", t("common.note"), t("history.refetch_already_tracking"));
        return;
      case "already_complete":
        notice("info", t("common.note"), t("history.refetch_already_complete"));
        return;
      case "replaced_succeeded":
        notice("success", t("common.success"), t("history.refetch_replaced"));
        return;
      case "kept_local_larger":
        notice("info", t("common.note"), t("history.refetch_kept_local"));
        return;
      case "resumed":
        notice("info", t("common.note"), t("history.refetch_resumed", { progress: outcome.progress }));
        return;
      case "updated_succeeded":
        notice("success", t("common.success"), t(outcome.downloaded ? "history.refetch_downloaded" : "history.refetch_updated_succeeded"));
        return;
      case "updated_failed":
        notice("warning", t("common.warning"), t("history.refetch_updated_failed", { status: outcome.status, reason: outcome.reason }));
        return;
      case "marked_expired":
        notice("warning", t("common.warning"), t("history.refetch_marked_expired"));
        return;
      case "expired_unchanged":
        notice("info", t("common.note"), t("history.refetch_expired_unchanged"));
        return;
      case "download_failed":
      case "network_error":
        notice("warning", t("common.warning"), t("history.refetch_failed", { reason: outcome.message }));
        return;
    }
  };

  const openVerifiedResult = async (task: HistoryTask) => {
    const fresh = (await openHistory().then((history) => history.getTask(task.id))) ?? task;
    const check = await verifyHistoryResultFile(fresh);
    if (!check.ok) {
      notice("warning", t("common.warning"), t(check.reason === "mismatch" ? "history.file_mismatch" : "history.file_missing"));
      return;
    }
    openPreview(check.path);
    if (check.needsBackfill) runAsync(backfillArtifacts(fresh));
  };

  const openVerifiedFolder = async (task: HistoryTask) => {
    const fresh = (await openHistory().then((history) => history.getTask(task.id))) ?? task;
    const check = await verifyHistoryResultFile(fresh);
    if (!check.ok) {
      notice("warning", t("common.warning"), t(check.reason === "mismatch" ? "history.file_mismatch" : "history.file_missing"));
      return;
    }
    await platform.opener.openPath(platform.paths.dirname(check.path));
  };

  const refetchOne = async (task: HistoryTask) => {
    const outcome = await historyRefetcher.refetchTask(task);
    await load(pageRef.current, { keepScroll: true });
    announceRefetch(outcome);
  };

  const refetchCurrentPage = async () => {
    if (pageRefetching || data.tasks.length === 0) return;
    setPageRefetching(true);
    try {
      const summary = await historyRefetcher.refetchPage(data.tasks);
      await load(pageRef.current, { keepScroll: true });
      const failed = summary.updatedFailed + summary.markedExpired;
      const skipped =
        summary.alreadyComplete +
        summary.alreadyTracking +
        summary.skippedInFlight +
        summary.expiredUnchanged +
        (summary.updatedSucceeded - summary.downloaded);
      notice(
        summary.errors > 0 ? "warning" : "success",
        summary.errors > 0 ? t("common.warning") : t("common.success"),
        t("history.refetch_page_done", {
          total: summary.total,
          resumed: summary.resumed,
          downloaded: summary.downloaded,
          failed,
          skipped,
          errors: summary.errors,
        }),
      );
    } finally {
      setPageRefetching(false);
    }
  };

  // 源项目的提示框默认落在「否」上，回车不会确认。Fluent 的对话框打开时会把焦点交给
  // 第一个可聚焦的按钮，这里在它之后把焦点挪回「否」；进入第二轮确认时再挪一次。
  useEffect(() => {
    if (confirmOpen) noButtonRef.current?.focus();
  }, [confirmOpen, confirm?.round]);

  const clear = async (kind: ClearKind) => {
    // 清理前先同步用量台账，避免老历史记录在尚未访问用量页前就被清空
    await backfillUsageLedger().catch(() => {});
    const history = await openHistory();
    const deleted =
      kind === "running"
        ? await history.clearRunningTasks()
        : kind === "failed"
          ? await history.clearFailedTasks()
          : kind === "violation"
            ? await history.clearViolationTasks()
            : await history.clearAllTasks();
    setSelectedIds(new Set());
    pageRef.current = 1;
    await load(1);
    notice("success", t("common.success"), t("history.clear_done", { count: deleted }));
  };

  const answer = (yes: boolean) => {
    if (!confirm) return;
    if (!yes) {
      setConfirmOpen(false);
      return;
    }
    // 清空全部要连着确认两次
    if (confirm.kind === "all" && confirm.round === 1) {
      setConfirm({ kind: "all", round: 2 });
      return;
    }
    setConfirmOpen(false);
    runAsync(clear(confirm.kind));
  };

  const confirmAction = confirm ? CLEAR_ACTIONS[confirm.kind] : null;
  const deleteConfirmText = deleteConfirm
    ? deleteConfirm.mode === "single"
      ? t("history.delete_single_confirm")
      : deleteConfirm.mode === "page"
        ? t("history.delete_page_confirm", { count: deleteConfirm.ids.length })
        : t("history.delete_selected_confirm", { count: deleteConfirm.ids.length })
    : "";

  return (
    <div ref={rootRef} className="page history">
      <div className="history__toolbar">
        {selectMode ? (
          <>
            <Button
              appearance="transparent"
              className="history__button"
              icon={<SelectAllOn20Regular />}
              disabled={data.tasks.length === 0}
              onClick={toggleSelectAllOnPage}
            >
              {allOnPageSelected ? t("history.deselect_all_page") : t("history.select_all_page")}
            </Button>
            <Button
              appearance="primary"
              className="history__button"
              icon={<Delete20Regular />}
              disabled={selectedIds.size === 0}
              onClick={() => requestDeleteConfirm("selected", [...selectedIds])}
            >
              {t("history.delete_selected", { count: selectedIds.size })}
            </Button>
            <Button
              appearance="secondary"
              className="history__button"
              icon={<Dismiss20Regular />}
              onClick={toggleSelectMode}
            >
              {t("history.exit_select")}
            </Button>
          </>
        ) : (
          <>
            {CLEAR_ORDER.map((kind) => (
              <Button
                key={kind}
                appearance="transparent"
                className="history__button"
                icon={<Delete20Regular />}
                onClick={() => {
                  setConfirm({ kind, round: 1 });
                  setConfirmOpen(true);
                }}
              >
                {t(CLEAR_ACTIONS[kind].titleKey)}
              </Button>
            ))}
            <Button
              appearance="transparent"
              className="history__button"
              icon={<Delete20Regular />}
              disabled={data.tasks.length === 0}
              onClick={() => requestDeleteConfirm("page", data.tasks.map((task) => task.id))}
            >
              {t("history.delete_page")}
            </Button>
            <Button
              appearance="transparent"
              className="history__button"
              icon={<CheckmarkSquare20Regular />}
              disabled={data.tasks.length === 0}
              onClick={toggleSelectMode}
            >
              {t("history.multi_select")}
            </Button>
            <Tooltip content={t("history.refetch_page_tooltip")} relationship="description">
              <Button
                appearance="transparent"
                className="history__button"
                icon={<ArrowClockwise20Regular />}
                disabled={pageRefetching || data.tasks.length === 0}
                onClick={() => runAsync(refetchCurrentPage())}
              >
                {t("history.refetch_page")}
              </Button>
            </Tooltip>
            <Button appearance="transparent" className="history__button" icon={<ArrowSync20Regular />} onClick={() => showPage(1)}>
              {t("history.refresh")}
            </Button>
          </>
        )}
      </div>
      <div ref={listRef} className="history__list" role="list">
        {data.tasks.length === 0 ? (
          <span className="history__empty">{t("history.no_history")}</span>
        ) : (
          data.tasks.map((task) => (
            <HistoryItem
              key={task.id}
              task={task}
              refetching={historyRefetcher.isInFlight(task.id)}
              tracking={isTaskIdActive(task.id)}
              selectMode={selectMode}
              selected={selectedIds.has(task.id)}
              onToggleSelect={toggleSelect}
              onContextMenu={openContextMenu}
              onRefetch={(selected) => runAsync(refetchOne(selected))}
              onOpenResult={(selected) => runAsync(openVerifiedResult(selected))}
              onOpenFolder={(selected) => runAsync(openVerifiedFolder(selected))}
              onShowDetails={(selected) => {
                setDetailsTask(selected);
                setDetailsOpen(true);
              }}
            />
          ))
        )}
      </div>
      <div className="history__pager">
        <Button
          appearance="transparent"
          className="history__button"
          icon={<ArrowLeft20Regular />}
          disabled={data.page <= 1}
          onClick={() => {
            if (pageRef.current > 1) showPage(pageRef.current - 1);
          }}
        >
          {t("history.previous")}
        </Button>
        <span className="history__page-label">
          {data.page} / {data.totalPages}
        </span>
        <Button
          appearance="transparent"
          className="history__button"
          icon={<ArrowRight20Regular />}
          iconPosition="after"
          disabled={data.page >= data.totalPages}
          onClick={() => showPage(pageRef.current + 1)}
        >
          {t("history.next")}
        </Button>
      </div>

      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="history-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className="history-context-menu__item history-context-menu__item--danger"
            role="menuitem"
            onClick={() => requestDeleteConfirm("single", [contextMenu.task.id])}
          >
            <Delete20Regular />
            <span>{t("history.delete_record")}</span>
          </button>
        </div>
      ) : null}

      <Dialog
        open={deleteConfirmOpen}
        onOpenChange={(_event, data) => {
          if (!data.open) setDeleteConfirmOpen(false);
        }}
      >
        <DialogSurface className="history-dialog">
          <DialogTitle>{t("history.delete_confirm_title")}</DialogTitle>
          <DialogBody>
            <DialogContent>
              <p className="history-dialog__text">{deleteConfirmText}</p>
            </DialogContent>
          </DialogBody>
          <DialogActions fluid>
            <Button ref={deleteCancelRef} onClick={() => setDeleteConfirmOpen(false)}>
              {t("history.delete_cancel")}
            </Button>
            <Button
              appearance="primary"
              onClick={() => {
                const ids = deleteConfirm?.ids ?? [];
                setDeleteConfirmOpen(false);
                if (ids.length > 0) runAsync(executeDelete(ids));
              }}
            >
              {t("history.delete_confirm")}
            </Button>
          </DialogActions>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={confirmOpen}
        onOpenChange={(_event, data) => {
          if (!data.open) setConfirmOpen(false);
        }}
      >
        <DialogSurface className="history-dialog">
          <DialogTitle>{confirmAction ? t(confirmAction.titleKey) : null}</DialogTitle>
          <DialogBody>
            <DialogContent>
              {confirm && confirmAction ? (
                <p className="history-dialog__text">{t(confirmTextKey(confirmAction, confirm.round))}</p>
              ) : null}
            </DialogContent>
          </DialogBody>
          <DialogActions fluid>
            <Button appearance="primary" onClick={() => answer(true)}>
              {t("history.confirm_yes")}
            </Button>
            <Button ref={noButtonRef} onClick={() => answer(false)}>
              {t("history.confirm_no")}
            </Button>
          </DialogActions>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={detailsOpen}
        onOpenChange={(_event, data) => {
          if (!data.open) setDetailsOpen(false);
        }}
      >
        <DialogSurface className="history-dialog history-dialog--details">
          <DialogTitle>{t("history.task_details")}</DialogTitle>
          {/* DialogBody 是正文和媒体的两栏网格，内容要放进 DialogContent 才占满整行 */}
          <DialogBody>
            <DialogContent className="history-details">{detailsTask ? <DetailsContent task={detailsTask} /> : null}</DialogContent>
          </DialogBody>
          <DialogActions fluid>
            <Button
              appearance="primary"
              onClick={() => {
                setDetailsOpen(false);
              }}
            >
              {t("history.close")}
            </Button>
          </DialogActions>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
