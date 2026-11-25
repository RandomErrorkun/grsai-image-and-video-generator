/**
 * 放不下的长文字自己来回滚：先停在开头，滚到结尾停住，再从开头来。
 * 只有文字比格子宽时才滚，放得下就一动不动。
 * 滚动速度是固定的像素每秒，看得清；开头和结尾各停一秒。
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
}

export function MarqueeText({ text, className, speed = 36, hold = 1 }: MarqueeTextProps) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

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

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || distance <= 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const travel = distance / speed;
    const duration = hold * 2 + travel;
    // 关键帧的百分比位置不能用 CSS 变量，所以用动画接口按时间点描述这一轮
    const animation = inner.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(0)", offset: hold / duration },
        { transform: `translateX(-${distance}px)`, offset: (hold + travel) / duration },
        { transform: `translateX(-${distance}px)` },
      ],
      { duration: duration * 1000, iterations: Number.POSITIVE_INFINITY },
    );
    return () => animation.cancel();
  }, [distance, speed, hold]);

  return (
    <span ref={outerRef} className={className ? `marquee ${className}` : "marquee"} title={distance > 0 ? text : undefined}>
      <span ref={innerRef} className="marquee__text">
        {text}
      </span>
    </span>
  );
}
