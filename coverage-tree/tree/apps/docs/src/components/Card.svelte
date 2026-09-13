<script>
  import avatar from '../../public/img/avatar.png';

  export let title = 'Card';
  const diagram = '/img/diagram.png';
</script>

<article class="card">
  <img src="/logo.png" alt="Root-relative, against the docs serving root" />
  <img src={avatar} alt="Imported" />
  <img src={diagram} alt="From a literal in the script block" />
  <img src="../../public/img/screenshot.png" alt="Relative" />
  <img src="/img/missing-from-svelte.png" alt="Broken on purpose" />
  <h2>{title}</h2>
</article>

<style>
  .card {
    background-image: url('/img/hero.jpg');
  }
</style>
