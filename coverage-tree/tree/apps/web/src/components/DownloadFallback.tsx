/** Hands over the photo a caller names, or the team photo when it names none. */
export function DownloadFallback({ photo }: { photo?: string }) {
  return (
    <a href={photo || '/img/team.jpg'} download>
      Download the photo
    </a>
  );
}
