/** Phase-two integration contract. MVP top-ups use admin grants and redeem codes. */
export interface PaymentProvider {
  createOrder(input: {
    workspaceId: string;
    packageId: string;
    amountCents: number;
  }): Promise<{ orderId: string; payUrl?: string; qrCode?: string }>;
  verifyNotify(request: Request): Promise<{ orderId: string; paid: boolean; raw: unknown }>;
}
