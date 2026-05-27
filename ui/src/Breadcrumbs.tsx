import { navigate } from "./router";

export interface Crumb {
  label: string;
  href?: string; // omit for the trailing (current) crumb
  title?: string;
}

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="breadcrumbs" aria-label="breadcrumb">
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="breadcrumb-item">
            {c.href !== undefined && !isLast ? (
              <button
                className="breadcrumb-link"
                onClick={() => navigate(c.href!)}
                title={c.title}
              >
                {c.label}
              </button>
            ) : (
              <span
                className={`breadcrumb-current ${isLast ? "is-last" : ""}`}
                title={c.title}
              >
                {c.label}
              </span>
            )}
            {!isLast && <span className="breadcrumb-sep" aria-hidden>›</span>}
          </span>
        );
      })}
    </nav>
  );
}

export default Breadcrumbs;
