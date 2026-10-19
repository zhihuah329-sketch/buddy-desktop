<script>
  /**
   * A labelled on/off control.
   *
   * One component rather than a bare checkbox: the label belongs to the row, the
   * state has to be readable at a glance, and a switch that is busy must not accept
   * a second click. A native `<button role="switch">` keeps it operable by keyboard
   * and announced correctly, which a styled `div` would not.
   */
  let {
    checked = false,
    label,
    description = '',
    disabled = false,
    busy = false,
    tone = 'accent',
    onToggle = () => {}
  } = $props()
</script>

<div class="row" class:off={!checked}>
  <div class="row-text">
    <span class="row-label">{label}</span>
    {#if description}
      <span class="row-desc">{description}</span>
    {/if}
  </div>

  <button
    class="switch"
    class:on={checked}
    class:tone-cn={tone === 'cn'}
    class:tone-ai={tone === 'ai'}
    role="switch"
    aria-checked={checked}
    aria-label={label}
    {disabled}
    onclick={() => onToggle(!checked)}
  >
    <span class="knob">
      {#if busy}
        <span class="spinner"></span>
      {/if}
    </span>
  </button>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 11px 13px;
    border-radius: var(--r-md);
    background: var(--bg-deep);
    border: 1px solid var(--line-soft);
    transition: border-color 160ms var(--ease), opacity 160ms var(--ease);
  }

  .row:hover {
    border-color: var(--line);
  }

  /* An off switch is dimmed, but its text stays legible: the point is to show what
     is not running, not to hide it. */
  .row.off .row-label {
    color: var(--ink-mid);
  }

  .row-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .row-label {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ink);
  }

  .row-desc {
    font-size: 10.5px;
    color: var(--ink-dim);
    line-height: 1.45;
  }

  .switch {
    position: relative;
    flex: none;
    width: 38px;
    height: 22px;
    padding: 0;
    border-radius: 99px;
    border: 1px solid var(--line-strong);
    background: var(--bg-raised);
    cursor: pointer;
    transition: background 180ms var(--ease), border-color 180ms var(--ease);
  }

  .switch:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .switch.on {
    background: var(--cn);
    border-color: var(--cn);
  }

  .switch.on.tone-ai {
    background: var(--ai);
    border-color: var(--ai);
  }

  /* The knob is white on both themes because it sits on a saturated accent when on,
     and needs to read against the grey track when off. */
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
    transition: transform 180ms var(--ease);
  }

  .switch.on .knob {
    transform: translateX(16px);
  }

  .spinner {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.4px solid rgba(0, 0, 0, 0.25);
    border-top-color: rgba(0, 0, 0, 0.6);
    animation: spin 640ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
