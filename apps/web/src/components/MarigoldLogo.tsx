import { useId } from 'react';

/** The marifold marigold mark (from the project logo SVG). Fills with
 * currentColor so callers tint it via CSS `color`. */
export function MarigoldLogo({ size = 16 }: { size?: number }) {
  // Six rotated <use>s of one petal path; the def id must be unique per
  // instance or multiple logos on a page would all reference the first.
  const petalId = useId();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
    >
      <defs>
        <path
          id={petalId}
          d="M512 175C477 201 443 226 423 241C410 253 403 272 403 287C403 304 409 318 420 326L500 390L500 323A26 26 0 1 1 524 323L524 390L604 326C615 316 620 299 619 282C619 266 611 250 597 236C573 214 543 198 512 175Z"
        />
      </defs>
      <g fill="currentColor">
        <use href={`#${petalId}`} />
        <use href={`#${petalId}`} transform="rotate(60 512 512)" />
        <use href={`#${petalId}`} transform="rotate(120 512 512)" />
        <use href={`#${petalId}`} transform="rotate(180 512 512)" />
        <use href={`#${petalId}`} transform="rotate(240 512 512)" />
        <use href={`#${petalId}`} transform="rotate(300 512 512)" />
        <circle cx="512" cy="512" r="60" />
      </g>
    </svg>
  );
}
