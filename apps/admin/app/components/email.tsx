/**
 * An email address that wraps only at its natural joints (before «@» and before each «.» of the
 * domain), never mid-word ("…alummahnow.ne / t"). Isolated left to right inside Arabic text.
 */
import { Fragment } from "react";

export function Email({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  const local = at > 0 ? value.slice(0, at) : value;
  const domain = at > 0 ? value.slice(at + 1).split(".") : [];
  return (
    <bdi dir="ltr" className={`[overflow-wrap:normal] [word-break:normal] ${className ?? ""}`}>
      {local}
      {at > 0 && (
        <>
          <wbr />@
          {domain.map((part, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <>
                  <wbr />.
                </>
              )}
              {part}
            </Fragment>
          ))}
        </>
      )}
    </bdi>
  );
}
