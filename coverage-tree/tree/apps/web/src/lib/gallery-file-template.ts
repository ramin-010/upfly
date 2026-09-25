/** The template spelling of galleryFile in paths.ts: the extension still arrives in the argument. */
export function galleryFileTemplate(nameWithExtension: string): string {
  return `/gallery/${nameWithExtension}`;
}
