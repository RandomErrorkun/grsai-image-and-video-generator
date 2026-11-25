/**
 * 放不下的长文字：鼠标悬停满一秒才开始来回滚，头尾各停一秒；移开立即回到开头。
 * 窗口或格子尺寸变化时重新量：放得下时滚动自动消失，放不下时自动出现。
 */
import { useEffect, useRef, useState } from "react";
import "./MarqueeText.css";

interface MarqueeTextProps {
  text: string;
  className?: string;
  /** 滚动速度，像素每秒。 */
  speed?: number;
  /** 两头各停多久，秒。 */
  hold?: number;
  /** 鼠标悬停满多久才开始滚，毫秒。 */
  hoverDelayMs?: number;
}

export function MarqueeText({ text, className, speed = 36, hold = 1, hoverDelayMs = 1000 }: MarqueeTextProps) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [scrolling, setScrolling] = useState(false);

  // 文字变了或格子宽窄变了，都重新量一次超出多少
  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const measure = () => setDistance(Math.max(0, inner.scrollWidth - outer.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [text]);

  // 悬停满一秒才启动滚动；移开或放得下时立刻停掉并归位
  useEffect(() => {
    if (!hovered || distance <= 0) {
      setScrolling(false);
      return;
    }
    const timer = window.setTimeout(() => setScrolling(true), hoverDelayMs);
    return () => {
      window.clearTimeout(timer);
      setScrolling(false);
    };
  }, [hovered, distance, hoverDelayMs]);

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || !scrolling || distance <= 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const travel = distance / speed;
    const duration = travel + hold * 2;
    const endStart = travel / duration;
    const endFinish = (travel + hold) / duration;
    // 悬停已经等满一秒，启动后直接从头滚到尾，尾停一秒，回到开头停一秒再滚下一轮
    const animation = inner.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: `translateX(-${distance}px)`, offset: endStart },
        { transform: `translateX(-${distance}px)`, offset: endFinish },
        { transform: "translateX(0)", offset: endFinish },
        { transform: "translateX(0)", offset: 1 },
      ],
      { duration: duration * 1000, iterations: Number.POSITIVE_INFINITY },
    );
    return () => animation.cancel();
  }, [scrolling, distance, speed, hold]);

  return (
    <span
      ref={outerRef}
      className={className ? `marquee ${className}` : "marquee"}
      title={distance > 0 ? text : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span ref={innerRef} className="marquee__text">
        {text}
      </span>
    </span>
  );
}
