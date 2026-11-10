import { useState } from "react";
import { useFetcher } from "react-router";
import { X, Plus, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Button } from "./ui/button";
import { UserRoleBadge } from "./user-role-badge";
import { ConfirmDialog } from "./confirm-dialog";

interface UserRoleManagerProps {
  userId: string;
  userEmail: string;
  currentRoles: Array<{ id: string; name: string }>;
  allRoles: Array<{ id: string; name: string; is_system: boolean }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRoleAssigned?: () => void;
  onRoleRemoved?: () => void;
}

/**
 * Dialog component for managing a user's role assignments
 * Allows adding and removing roles with real-time API updates
 */
export function UserRoleManager({
  userId,
  userEmail,
  currentRoles,
  allRoles,
  open,
  onOpenChange,
  onRoleAssigned,
  onRoleRemoved,
}: UserRoleManagerProps) {
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [roleToRemove, setRoleToRemove] = useState<{ id: string; name: string } | null>(null);

  const assignFetcher = useFetcher();
  const removeFetcher = useFetcher();

  // Filter out already assigned roles from the dropdown
  const currentRoleIds = new Set(currentRoles.map((r) => r.id));
  const availableRoles = allRoles.filter((role) => !currentRoleIds.has(role.id));

  const handleAddRole = async () => {
    if (!selectedRoleId) return;

    setLoadingAction(`add-${selectedRoleId}`);

    // Submit via fetcher to the appropriate action route
    assignFetcher.submit(
      {
        action: "assign-role",
        userId,
        roleId: selectedRoleId,
      },
      {
        method: "POST",
        action: "/api/users/roles",
      }
    );

    // Reset selection after submission
    setSelectedRoleId("");
    setLoadingAction(null);

    if (onRoleAssigned) {
      onRoleAssigned();
    }
  };

  const handleRemoveRole = async (roleId: string) => {
    setLoadingAction(`remove-${roleId}`);

    // Submit via fetcher to the appropriate action route
    removeFetcher.submit(
      {
        action: "remove-role",
        userId,
        roleId,
      },
      {
        method: "POST",
        action: "/api/users/roles",
      }
    );

    setLoadingAction(null);

    if (onRoleRemoved) {
      onRoleRemoved();
    }
  };

  const isLoading = assignFetcher.state !== "idle" || removeFetcher.state !== "idle";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Manage Roles for {userEmail}</DialogTitle>
          <DialogDescription>
            Add or remove roles to control user permissions
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Current Roles Section */}
          <div>
            <h3 className="text-sm font-semibold mb-3">Current Roles</h3>
            {currentRoles.length === 0 ? (
              <p className="text-sm text-[rgb(var(--color-muted-foreground))]">
                No roles assigned yet
              </p>
            ) : (
              <div className="space-y-2">
                {currentRoles.map((role) => (
                  <div
                    key={role.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))]"
                  >
                    <UserRoleBadge role={role.name} />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setRoleToRemove(role)}
                      disabled={isLoading || loadingAction === `remove-${role.id}`}
                      className="h-8 w-8"
                    >
                      {loadingAction === `remove-${role.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <X className="h-4 w-4" />
                      )}
                      <span className="sr-only">Remove {role.name}</span>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add Role Section */}
          <div>
            <h3 className="text-sm font-semibold mb-3">Add Role</h3>
            {availableRoles.length === 0 ? (
              <p className="text-sm text-[rgb(var(--color-muted-foreground))]">
                All roles have been assigned
              </p>
            ) : (
              <div className="flex gap-2">
                <Select
                  value={selectedRoleId}
                  onValueChange={setSelectedRoleId}
                  disabled={isLoading}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRoles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        <span className="flex items-center gap-2">
                          {role.name}
                          {role.is_system && (
                            <span className="text-xs text-[rgb(var(--color-muted-foreground))]">
                              (System)
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={handleAddRole}
                  disabled={!selectedRoleId || isLoading}
                  className="shrink-0"
                >
                  {loadingAction?.startsWith("add-") ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Add
                </Button>
              </div>
            )}
          </div>
        </div>
        <ConfirmDialog
          open={!!roleToRemove}
          cancelLabel="Cancel"
          onCancel={() => setRoleToRemove(null)}
          title="Remove this role?"
          description={roleToRemove ? `${userEmail} loses the "${roleToRemove.name}" role and every permission it grants.` : ""}
          confirmLabel="Remove role"
          onConfirm={() => {
            if (roleToRemove) handleRemoveRole(roleToRemove.id);
            setRoleToRemove(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
