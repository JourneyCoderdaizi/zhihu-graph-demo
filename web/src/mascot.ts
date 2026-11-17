/** 刘看山吉祥物：按交互场景切换动作 GIF，并播放气泡提示 */

import idleUrl from '../assets/kanshan/idle.gif';
import waveUrl from '../assets/kanshan/wave.gif';
import computerUrl from '../assets/kanshan/computer.gif';
import ballUrl from '../assets/kanshan/ball.gif';
import swayUrl from '../assets/kanshan/sway.gif';
import sleepUrl from '../assets/kanshan/sleep.gif';

export type MascotAct = 'idle' | 'wave' | 'computer' | 'ball' | 'sway' | 'sleep';

const SRC: Record<MascotAct, string> = {
  idle: idleUrl,
  wave: waveUrl,
  computer: computerUrl,
  ball: ballUrl,
  sway: swayUrl,
  sleep: sleepUrl,
};

/** 各动作时长（毫秒），来自素材文件名标注 */
const DURATION: Record<MascotAct, number> = {
  idle: 5000, wave: 4000, computer: 6000, ball: 4000, sway: 3000, sleep: 5000,
};

export class Mascot {
  private el: HTMLDivElement;
  private img: HTMLImageElement;
  private tip: HTMLDivElement;
  private backTimer = 0;
  private tipTimer = 0;
  private idleTimer = 0;
  private current: MascotAct = 'idle';

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'mascot';
    this.el.title = '刘看山';

    this.img = document.createElement('img');
    this.img.src = SRC.idle;
    this.img.alt = '刘看山';
    this.img.draggable = false;

    this.tip = document.createElement('div');
    this.tip.className = 'tip';

    this.el.append(this.tip, this.img);
    parent.appendChild(this.el);

    this.el.addEventListener('click', () => {
      this.play('ball', '再看看这张地图？');
    });
    this.el.addEventListener('mouseenter', () => {
      if (this.current === 'idle' || this.current === 'sleep') this.play('wave');
    });

    this.scheduleIdle();
  }

  /** 播放一个动作，结束后自动回到待机 */
  play(act: MascotAct, say?: string): void {
    window.clearTimeout(this.backTimer);
    this.current = act;
    // 加时间戳强制重放 GIF，否则同名 src 不会从头播
    this.img.src = `${SRC[act]}${SRC[act].includes('?') ? '&' : '?'}t=${Date.now()}`;
    if (say) this.say(say);
    if (act !== 'idle') {
      this.backTimer = window.setTimeout(() => this.play('idle'), DURATION[act]);
    }
    this.scheduleIdle();
  }

  say(text: string, ms = 2600): void {
    window.clearTimeout(this.tipTimer);
    this.tip.textContent = text;
    this.el.classList.add('talk');
    this.tipTimer = window.setTimeout(() => this.el.classList.remove('talk'), ms);
  }

  /** 长时间无操作后打瞌睡 */
  private scheduleIdle(): void {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.current === 'idle') this.play('sleep');
    }, 42000);
  }

  destroy(): void {
    window.clearTimeout(this.backTimer);
    window.clearTimeout(this.tipTimer);
    window.clearTimeout(this.idleTimer);
    this.el.remove();
  }
}
