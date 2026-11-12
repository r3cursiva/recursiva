// Last line of defence: a render error anywhere shows a short message with a reload button instead of a frozen page.
import { Button } from "@rsva/ui/components/button";
import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-auto flex max-w-sm flex-col gap-3 p-6 text-sm">
        <h1 className="text-base font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground">{this.state.error.message}</p>
        <Button
          variant="link"
          className="h-auto self-start border-0 px-0 text-sm font-normal text-inherit underline active:scale-100! max-md:h-auto max-md:px-0 max-md:text-sm"
          onClick={() => location.reload()}
        >
          Reload
        </Button>
      </div>
    );
  }
}
