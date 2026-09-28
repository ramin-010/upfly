<?php
$plate = '/gallery/plate.jpg';
$emblem = '../app/assets/emblem.png';
?>
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gallery</title>
    <style>
      body {
        background-image: url('/gallery/plate.jpg');
      }
    </style>
  </head>
  <body>
    <img src="<?= $plate ?>" alt="From a variable" />
    <img src="/gallery/plate.jpg" alt="Root-relative literal, in PHP" />
    <img src="gallery/plate.jpg" alt="Bare relative, in PHP" />
    <img src="/gallery/missing-from-php.png" alt="Broken on purpose" />
  </body>
</html>
