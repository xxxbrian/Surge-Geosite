<script lang="ts">
	import type { Snippet } from 'svelte';

	import { cn } from '$lib/utils.js';

	let {
		title,
		contentClass,
		children
	}: {
		title: string;
		contentClass?: string;
		children: Snippet;
	} = $props();
</script>

<section class="space-y-2">
	<h4 class="text-muted-foreground text-xs font-semibold tracking-[0.14em]">{title}</h4>
	<div class={cn('border text-xs', contentClass)}>
		{@render children()}
	</div>
</section>
