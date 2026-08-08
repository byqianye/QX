<template>
  <main class="launch-splash" data-testid="launch-splash" aria-live="polite">
    <div class="launch-splash-mark" aria-hidden="true">
      <svg viewBox="0 0 256 256" role="img">
        <circle cx="128" cy="128" r="96" fill="currentColor" />
        <circle cx="128" cy="128" r="54" fill="none" stroke="var(--surface)" stroke-width="18" />
        <path d="M158 158 194 194" fill="none" stroke="var(--accent)" stroke-linecap="round" stroke-width="18" />
      </svg>
    </div>
    <span class="section-kicker">QX 影视</span>
    <h1>正在启动工作台</h1>
    <p>Initializing Runtime · Loading Database · Starting Engines</p>
    <span class="launch-splash-progress" aria-hidden="true" />
  </main>
</template>
