import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

/** Icon-inspired pixel head. Discrete frames avoid blurring the pixel grid. */
export function Mascot({ size = 72 }: { size?: number }) {
  const [frame, setFrame] = useState(0);
  const [reduced, setReduced] = useState(true);
  const [active, setActive] = useState(AppState.currentState == null || AppState.currentState === 'active');
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (mounted) setReduced(value); });
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    const state = AppState.addEventListener('change', (value) => setActive(value === 'active'));
    return () => { mounted = false; motion.remove(); state.remove(); };
  }, []);
  useEffect(() => {
    if (reduced || !active) { setFrame(0); return; }
    const timer = setInterval(() => setFrame((value) => (value + 1) % 40), 200);
    return () => clearInterval(timer);
  }, [reduced, active]);
  const happy = frame >= 30 && frame <= 35;
  const blink = frame === 14;
  const hop = frame % 20 === 10 ? -2 : frame % 20 === 9 || frame % 20 === 11 ? -1 : 0;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityLabel="Nekko, a pixel cat" accessibilityRole="image">
      <G transform={`translate(0 ${hop})`} strokeLinejoin="miter">
        <Path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#101714" stroke="#f2f1e9" strokeWidth={2} />
        <Path fill="#f2f1e9" d={happy
          ? 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z'
          : blink ? 'M10 17H14V18H10Z M19 17H23V18H19Z' : 'M11 15H13V18H11Z M20 15H22V18H20Z'} />
        <Path d="M15 20H17V21H15Z" fill="#a7c8ac" />
      </G>
    </Svg>
  );
}
