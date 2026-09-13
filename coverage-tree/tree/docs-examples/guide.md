# Writing a page

This folder holds runnable examples for the guide. **`docs-examples/public/` is not a
serving root.** It is named `public` because the examples are about a project that has
one, and that is exactly why it is here: B2 and B3 both named a `public/` directory that
is not a serving root as the biggest untested risk, and no repository in the corpus has
one.

## Example: a hero image

```html
<img src="/hero.png" alt="The hero" />
<img src="/logo.png" alt="The logo" />
```

```css
.hero {
  background-image: url('/sample.png');
}
```

The example above assumes a project whose serving root contains `hero.png`. This project's
serving roots do not, and the example is not a reference into this repository at all.

## The files beside this one

`public/sample.png` and `public/logo.png` are here so that the directory is not empty.
They are illustrations for the guide rather than assets of any site.

![An illustration, referenced for real](public/sample.png)

![The other one](./public/logo.png)
