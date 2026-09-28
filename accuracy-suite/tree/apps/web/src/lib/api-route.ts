/** A concatenated URL that names an API route, not a file: there is nothing to find here. */
export function userUrl(id: string): string {
  return '/api/users/' + id;
}
