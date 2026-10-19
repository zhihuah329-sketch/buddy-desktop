<script>
  /**
   * The toast stack.
   *
   * Outcomes are reported here rather than inside the page, so a message never
   * shifts the layout it is describing. Each entry leaves on its own timer.
   */
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  let { items } = $props()
</script>

<div class="toasts">
  {#each items as entry (entry.id)}
    <div
      class="toast {entry.tone}"
      in:fly={{ y: -10, duration: 220, easing: cubicOut }}
      out:fly={{ y: -10, duration: 160 }}
    >
      {entry.text}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 50;
    pointer-events: none;
  }

  .toast {
    padding: 7px 14px;
    border-radius: 99px;
    font-size: 11.5px;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    color: var(--ink-mid);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    white-space: nowrap;
  }

  .toast.good { color: var(--good); border-color: rgba(69, 209, 122, 0.3); }
  .toast.warn { color: var(--warn); border-color: rgba(227, 168, 58, 0.3); }
  .toast.bad { color: var(--bad); border-color: rgba(242, 86, 77, 0.3); }
</style>
