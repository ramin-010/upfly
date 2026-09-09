// A realistic React component. Every commented-out path below is a trap for any
// implementation that reaches for a regular expression.

import React from 'react';
import styled from 'styled-components';

import logo from './assets/logo.png';
import hero from '../images/hero.jpg?as=webp';
import './Gallery.css';

// import retired from './assets/retired.png';

/**
 * @example
 *   import example from './assets/example.png';
 */

const banner = new URL('./assets/banner.avif', import.meta.url);
const thumb = require('./assets/thumb.png');

const Frame = styled.div`
  background-image: url(../images/frame.png);
  color: ${({ theme }) => theme.fg};

  &:hover {
    background-image: url(../images/frame-hover.png);
  }

  /* url(../images/never.png) */
`;

const note = 'this string mentions ./assets/mentioned.png but is not a reference';

export function Gallery({ slug }) {
  const dynamic = `/generated/${slug}.png`;

  return (
    <Frame>
      <img src={logo} alt="Logo" />
      <img src="/static/inline.png" srcSet="/static/inline@2x.png 2x" alt="Inline" />
      <img src={dynamic} alt="Dynamic" />
      <img src={`/generated/${slug}-wide.png`} alt="Templated" />
      <video poster="/static/poster.png" src="/media/clip.mp4" />
      <img src="https://cdn.example.com/remote.png" alt="Remote" />
    </Frame>
  );
}
