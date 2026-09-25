/** Opens an album page. A folder of pictures with the same name proves nothing about this call. */
export function openAlbum(router: { push(path: string): void }, albumId: string): void {
  router.push('/gallery/' + albumId);
}
