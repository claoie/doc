import { Link } from "../router";
import { EmptyState } from "../components/ui";
import { TopBar } from "../layout/TopBar";

export const NotFound = () => (
  <>
    <TopBar crumbs={[{ label: "Not found" }]} />
    <div className="content">
      <EmptyState icon="page" title="Page not found">
        It may have been moved or deleted, or you may not have access. <Link to="/">Go home</Link>
      </EmptyState>
    </div>
  </>
);
