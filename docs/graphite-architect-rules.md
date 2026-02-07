# Architectural Review Rules

Review pull requests for cross-cutting architectural concerns: module boundaries, dependency direction, layer violations, API contract consistency, and shared state management. Apply these rules to TypeScript and C#/.NET codebases.

---

## 1. Require constructor injection for service dependencies

Require all service-class dependencies to be received via constructor parameters, never instantiated directly with `new` inside method bodies or field initializers.

**BAD — TypeScript:**
```typescript
// order-service.ts
import { PaymentGateway } from '../payments/payment-gateway.js';
import { InventoryService } from '../inventory/inventory-service.js';

export class OrderService {
  async placeOrder(order: Order): Promise<OrderResult> {
    const payments = new PaymentGateway();
    const inventory = new InventoryService();

    await inventory.reserve(order.items);
    const charge = await payments.charge(order.total);
    return { orderId: order.id, chargeId: charge.id };
  }
}
```

**BAD — C#:**
```csharp
public class OrderService
{
    public async Task<OrderResult> PlaceOrderAsync(Order order)
    {
        var payments = new PaymentGateway();
        var inventory = new InventoryService();

        await inventory.ReserveAsync(order.Items);
        var charge = await payments.ChargeAsync(order.Total);
        return new OrderResult(order.Id, charge.Id);
    }
}
```

**GOOD — TypeScript:**
```typescript
import type { IPaymentGateway } from '../payments/payment-gateway.interface.js';
import type { IInventoryService } from '../inventory/inventory-service.interface.js';

export class OrderService {
  constructor(
    private readonly payments: IPaymentGateway,
    private readonly inventory: IInventoryService,
  ) {}

  async placeOrder(order: Order): Promise<OrderResult> {
    await this.inventory.reserve(order.items);
    const charge = await this.payments.charge(order.total);
    return { orderId: order.id, chargeId: charge.id };
  }
}
```

**GOOD — C#:**
```csharp
public sealed class OrderService
{
    private readonly IPaymentGateway _payments;
    private readonly IInventoryService _inventory;

    public OrderService(IPaymentGateway payments, IInventoryService inventory)
    {
        _payments = payments;
        _inventory = inventory;
    }

    public async Task<OrderResult> PlaceOrderAsync(Order order)
    {
        await _inventory.ReserveAsync(order.Items);
        var charge = await _payments.ChargeAsync(order.Total);
        return new OrderResult(order.Id, charge.Id);
    }
}
```

Direct instantiation of service classes creates tight coupling that prevents testing in isolation and violates Dependency Inversion. When a service constructs its own collaborators, you cannot substitute test doubles, and changing one module's constructor signature forces changes across every consumer.

---

## 2. Require imports from module public API, not internal files

Require cross-module imports to use the module's barrel export (`index.ts` / public namespace), never import directly from internal implementation files within a sibling module.

**BAD — TypeScript:**
```typescript
// features/billing/invoice-generator.ts
import { calculateTax } from '../pricing/internal/tax-calculator.js';
import { applyDiscount } from '../pricing/utils/discount-helper.js';
import type { PriceBreakdown } from '../pricing/models/price-breakdown.js';

export function generateInvoice(lineItems: LineItem[]): Invoice {
  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const tax = calculateTax(subtotal, 'US');
  const total = applyDiscount(subtotal + tax, 0.1);
  return { lineItems, subtotal, tax, total };
}
```

**BAD — C#:**
```csharp
// Features/Billing/InvoiceGenerator.cs
using Pricing.Internal;
using Pricing.Utils;

public sealed class InvoiceGenerator
{
    public Invoice Generate(List<LineItem> lineItems)
    {
        var subtotal = lineItems.Sum(i => i.Amount);
        var tax = TaxCalculator.Calculate(subtotal, "US");
        var total = DiscountHelper.Apply(subtotal + tax, 0.1m);
        return new Invoice(lineItems, subtotal, tax, total);
    }
}
```

**GOOD — TypeScript:**
```typescript
// features/billing/invoice-generator.ts
import { calculateTax, applyDiscount } from '../pricing/index.js';
import type { PriceBreakdown } from '../pricing/index.js';

export function generateInvoice(lineItems: LineItem[]): Invoice {
  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const tax = calculateTax(subtotal, 'US');
  const total = applyDiscount(subtotal + tax, 0.1);
  return { lineItems, subtotal, tax, total };
}
```

**GOOD — C#:**
```csharp
// Features/Billing/InvoiceGenerator.cs
using Pricing;

public sealed class InvoiceGenerator
{
    private readonly IPricingService _pricing;

    public InvoiceGenerator(IPricingService pricing) => _pricing = pricing;

    public Invoice Generate(List<LineItem> lineItems)
    {
        var subtotal = lineItems.Sum(i => i.Amount);
        var tax = _pricing.CalculateTax(subtotal, "US");
        var total = _pricing.ApplyDiscount(subtotal + tax, 0.1m);
        return new Invoice(lineItems, subtotal, tax, total);
    }
}
```

Importing from internal module files creates invisible coupling to implementation details. When the module refactors its internals, every consumer that reached past the public API breaks. Barrel exports define an explicit contract boundary that the module author controls.

---

## 3. Reject circular dependencies between modules

Reject any import cycle between modules. If module A imports from module B, module B must not import from module A at any depth. Extract shared types into a separate module or use dependency inversion with interfaces.

**BAD — TypeScript:**
```typescript
// modules/orders/order-service.ts
import { NotificationService } from '../notifications/notification-service.js';

export class OrderService {
  constructor(private readonly notifications: NotificationService) {}

  async placeOrder(order: Order): Promise<void> {
    await this.notifications.sendOrderConfirmation(order);
  }
}

// modules/notifications/notification-service.ts
import { OrderService } from '../orders/order-service.js'; // CIRCULAR

export class NotificationService {
  constructor(private readonly orders: OrderService) {}

  async retryFailedNotifications(): Promise<void> {
    const pendingOrders = await this.orders.getPendingOrders();
  }
}
```

**BAD — C#:**
```csharp
// Modules/Orders/OrderService.cs
using Notifications;

public sealed class OrderService
{
    private readonly NotificationService _notifications;
}

// Modules/Notifications/NotificationService.cs
using Orders; // CIRCULAR

public sealed class NotificationService
{
    private readonly OrderService _orders;
}
```

**GOOD — TypeScript:**
```typescript
// modules/orders/order-events.ts
export interface OrderPlacedEvent {
  readonly orderId: string;
  readonly customerEmail: string;
}

export interface IOrderEventHandler {
  onOrderPlaced(event: OrderPlacedEvent): Promise<void>;
}

// modules/orders/order-service.ts
import type { IOrderEventHandler } from './order-events.js';

export class OrderService {
  constructor(private readonly eventHandler: IOrderEventHandler) {}

  async placeOrder(order: Order): Promise<void> {
    await this.eventHandler.onOrderPlaced({
      orderId: order.id,
      customerEmail: order.email,
    });
  }
}

// modules/notifications/notification-handler.ts
import type { IOrderEventHandler, OrderPlacedEvent } from '../orders/order-events.js';

export class NotificationHandler implements IOrderEventHandler {
  async onOrderPlaced(event: OrderPlacedEvent): Promise<void> {
    // No back-reference to OrderService
  }
}
```

**GOOD — C#:**
```csharp
// Shared/Events/IOrderEventHandler.cs
public interface IOrderEventHandler
{
    Task OnOrderPlacedAsync(OrderPlacedEvent evt);
}

// Modules/Orders/OrderService.cs
public sealed class OrderService
{
    private readonly IOrderEventHandler _eventHandler;
    public OrderService(IOrderEventHandler handler) => _eventHandler = handler;
}

// Modules/Notifications/NotificationHandler.cs
public sealed class NotificationHandler : IOrderEventHandler
{
    public async Task OnOrderPlacedAsync(OrderPlacedEvent evt) { /* ... */ }
}
```

Circular dependencies make it impossible to understand, test, or deploy modules independently. They create cascading build failures and indicate that module boundaries are incorrectly drawn. Breaking cycles with interfaces or events preserves unidirectional dependency flow.

---

## 4. Reject business logic in controllers, handlers, or API route definitions

Require controllers, HTTP handlers, and API route handlers to delegate all business logic to service or domain layer functions. Controllers must only parse input, call a service method, and map the result to an HTTP response.

**BAD — TypeScript:**
```typescript
// routes/orders.ts
app.post('/orders', async (req, res) => {
  const { items, customerId } = req.body;

  let total = 0;
  for (const item of items) {
    const product = await db.products.findById(item.productId);
    if (!product) return res.status(400).json({ error: `Product ${item.productId} not found` });
    if (product.stock < item.quantity) return res.status(400).json({ error: 'Insufficient stock' });
    total += product.price * item.quantity;
    await db.products.update(item.productId, { stock: product.stock - item.quantity });
  }

  const tax = total * 0.08;
  const order = await db.orders.create({ customerId, items, total: total + tax });
  await emailService.send(customerId, `Order ${order.id} confirmed`);

  res.status(201).json(order);
});
```

**BAD — C#:**
```csharp
[HttpPost]
public async Task<IActionResult> CreateOrder([FromBody] CreateOrderRequest request)
{
    decimal total = 0;
    foreach (var item in request.Items)
    {
        var product = await _db.Products.FindAsync(item.ProductId);
        if (product is null) return BadRequest($"Product {item.ProductId} not found");
        if (product.Stock < item.Quantity) return BadRequest("Insufficient stock");
        total += product.Price * item.Quantity;
        product.Stock -= item.Quantity;
    }

    var tax = total * 0.08m;
    var order = new Order { CustomerId = request.CustomerId, Total = total + tax };
    _db.Orders.Add(order);
    await _db.SaveChangesAsync();
    await _email.SendAsync(request.CustomerId, $"Order {order.Id} confirmed");

    return CreatedAtAction(nameof(GetOrder), new { id = order.Id }, order);
}
```

**GOOD — TypeScript:**
```typescript
// routes/orders.ts
app.post('/orders', async (req, res) => {
  const result = await orderService.placeOrder(req.body);

  if (!result.success) {
    return res.status(400).json({ code: result.error.code, message: result.error.message });
  }

  res.status(201).json(result.data);
});
```

**GOOD — C#:**
```csharp
[HttpPost]
public async Task<IActionResult> CreateOrder([FromBody] CreateOrderRequest request)
{
    var result = await _orderService.PlaceOrderAsync(request);
    return result.Match<IActionResult>(
        order => CreatedAtAction(nameof(GetOrder), new { id = order.Id }, order),
        error => BadRequest(new ApiError(error.Code, error.Message))
    );
}
```

When business logic lives in controllers, it cannot be reused across different entry points (CLI, message queue, scheduled jobs), cannot be unit tested without HTTP context, and blurs the boundary between transport concerns and domain rules.

---

## 5. Reject data access calls from UI or presentation layer code

Require all database queries, repository calls, and direct data-access operations to be performed exclusively in the service or data-access layer. UI components, view models, and presentation-layer code must never import or call repositories, ORM contexts, or query builders directly.

**BAD — TypeScript:**
```typescript
// components/UserDashboard.tsx
import { prisma } from '../../lib/prisma';

export async function UserDashboard({ userId }: Props) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { orders: { take: 10, orderBy: { createdAt: 'desc' } } },
  });

  const stats = await prisma.$queryRaw`
    SELECT COUNT(*) as total, SUM(amount) as revenue
    FROM orders WHERE user_id = ${userId}
  `;

  return <div>{/* render user and stats */}</div>;
}
```

**BAD — C#:**
```csharp
// ViewModels/UserDashboardViewModel.cs
public class UserDashboardViewModel : ViewModelBase
{
    private readonly AppDbContext _db;

    public async Task LoadAsync(int userId)
    {
        User = await _db.Users
            .Include(u => u.Orders.OrderByDescending(o => o.CreatedAt).Take(10))
            .FirstOrDefaultAsync(u => u.Id == userId);

        Stats = await _db.Orders
            .Where(o => o.UserId == userId)
            .GroupBy(_ => 1)
            .Select(g => new { Total = g.Count(), Revenue = g.Sum(o => o.Amount) })
            .FirstOrDefaultAsync();
    }
}
```

**GOOD — TypeScript:**
```typescript
// components/UserDashboard.tsx
import type { UserDashboardData } from '../../services/user-service.js';

export function UserDashboard({ data }: { data: UserDashboardData }) {
  return <div>{/* render pre-fetched data */}</div>;
}
```

**GOOD — C#:**
```csharp
// ViewModels/UserDashboardViewModel.cs
public sealed class UserDashboardViewModel : ViewModelBase
{
    private readonly IUserService _userService;

    public UserDashboardViewModel(IUserService userService) => _userService = userService;

    public async Task LoadAsync(int userId)
    {
        var data = await _userService.GetDashboardDataAsync(userId);
        User = data.User;
        Stats = data.Stats;
    }
}
```

When UI code queries the database directly, it couples the presentation layer to the data schema, makes query logic impossible to reuse or test independently, and circumvents authorization, caching, and validation that should live in the service layer.

---

## 6. Require consistent error response shapes across all API endpoints

Require all API error responses to use a single, consistent error shape containing at minimum a machine-readable `code` and a human-readable `message`. Reject endpoints that return ad-hoc error strings, bare messages, or inconsistent error object structures.

**BAD — TypeScript:**
```typescript
// routes/users.ts
app.get('/users/:id', async (req, res) => {
  const user = await userService.findById(req.params.id);
  if (!user) return res.status(404).send('not found');              // bare string
});

// routes/orders.ts
app.post('/orders', async (req, res) => {
  try {
    const order = await orderService.create(req.body);
    res.json(order);
  } catch (err) {
    res.status(500).json({ msg: (err as Error).message });          // different shape
  }
});

// routes/products.ts
app.put('/products/:id', async (req, res) => {
  const result = await productService.update(req.params.id, req.body);
  if (!result.ok) {
    return res.status(400).json({ errors: result.validationErrors }); // yet another shape
  }
  res.json(result.data);
});
```

**BAD — C#:**
```csharp
// UsersController.cs
[HttpGet("{id}")]
public async Task<IActionResult> Get(int id)
{
    var user = await _userService.FindAsync(id);
    if (user is null) return NotFound("not found");               // bare string
}

// OrdersController.cs
[HttpPost]
public async Task<IActionResult> Create([FromBody] OrderDto dto)
{
    return BadRequest(new { msg = "Invalid order" });             // ad-hoc shape
}

// ProductsController.cs
[HttpPut("{id}")]
public async Task<IActionResult> Update(int id, [FromBody] ProductDto dto)
{
    return UnprocessableEntity(new { errors = validationErrors }); // yet another shape
}
```

**GOOD — TypeScript:**
```typescript
// shared/api-error.ts
interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly { field: string; issue: string }[];
}

function errorResponse(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ code, message } satisfies ApiError);
}

// routes/users.ts
app.get('/users/:id', async (req, res) => {
  const user = await userService.findById(req.params.id);
  if (!user) return errorResponse(res, 404, 'USER_NOT_FOUND', `User ${req.params.id} not found`);
  res.json(user);
});
```

**GOOD — C#:**
```csharp
// Shared/ApiError.cs
public sealed record ApiError(string Code, string Message, IReadOnlyList<FieldError>? Details = null);

public static class ApiErrors
{
    public static ObjectResult Create(int status, string code, string message)
        => new(new ApiError(code, message)) { StatusCode = status };
}

// UsersController.cs
[HttpGet("{id}")]
public async Task<IActionResult> Get(int id)
{
    var user = await _userService.FindAsync(id);
    if (user is null) return ApiErrors.Create(404, "USER_NOT_FOUND", $"User {id} not found");
    return Ok(user);
}
```

Inconsistent error shapes force every API consumer to handle multiple error formats, making error handling fragile and error-prone. A canonical error shape with a machine-readable code enables automated retry logic, monitoring dashboards, and client-side error mapping without parsing human text.

---

## 7. Require typed Result wrappers for cross-module error propagation

Require recoverable errors that cross module boundaries to be returned as typed Result/Either objects, not thrown exceptions, so that callers must explicitly handle both success and failure paths at compile time.

**BAD — TypeScript:**
```typescript
// services/payment-service.ts
export class PaymentService {
  async charge(amount: number, cardToken: string): Promise<ChargeConfirmation> {
    const response = await this.gateway.processPayment(amount, cardToken);
    if (response.declined) {
      throw new Error('Payment declined');        // caller might forget to catch
    }
    if (response.insufficientFunds) {
      throw new Error('Insufficient funds');      // same throw for different failures
    }
    return { chargeId: response.id, amount };
  }
}

// Caller has no compile-time hint that this can fail
const confirmation = await paymentService.charge(100, token);
```

**BAD — C#:**
```csharp
public sealed class PaymentService
{
    public async Task<ChargeConfirmation> ChargeAsync(decimal amount, string cardToken)
    {
        var response = await _gateway.ProcessPaymentAsync(amount, cardToken);
        if (response.Declined)
            throw new PaymentDeclinedException("Payment declined");    // unchecked
        if (response.InsufficientFunds)
            throw new InsufficientFundsException("Insufficient funds");
        return new ChargeConfirmation(response.Id, amount);
    }
}

// Caller has no compile-time hint that this can fail
var confirmation = await paymentService.ChargeAsync(100, token);
```

**GOOD — TypeScript:**
```typescript
type PaymentError =
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'insufficient-funds'; readonly available: number }
  | { readonly kind: 'gateway-error'; readonly message: string };

type PaymentResult = Result<ChargeConfirmation, PaymentError>;

export class PaymentService {
  async charge(amount: number, cardToken: string): Promise<PaymentResult> {
    const response = await this.gateway.processPayment(amount, cardToken);
    if (response.declined) {
      return { success: false, error: { kind: 'declined', reason: response.declineReason } };
    }
    return { success: true, data: { chargeId: response.id, amount } };
  }
}

// Caller is forced to handle both paths
const result = await paymentService.charge(100, token);
if (!result.success) {
  // handle result.error with exhaustive switch on result.error.kind
}
```

**GOOD — C#:**
```csharp
public sealed class PaymentService
{
    public async Task<Result<ChargeConfirmation, PaymentError>> ChargeAsync(
        decimal amount, string cardToken)
    {
        var response = await _gateway.ProcessPaymentAsync(amount, cardToken);
        if (response.Declined)
            return Result.Fail<ChargeConfirmation, PaymentError>(
                new PaymentError.Declined(response.DeclineReason));
        return Result.Ok<ChargeConfirmation, PaymentError>(
            new ChargeConfirmation(response.Id, amount));
    }
}

// Caller must pattern match on result
var result = await paymentService.ChargeAsync(100m, token);
result.Match(
    ok => /* handle success */,
    err => /* handle typed error */
);
```

Thrown exceptions for recoverable failures are invisible in the type signature. Callers have no compile-time signal that a method can fail. Result types make the failure path explicit at the API boundary, prevent unhandled exceptions from propagating to unexpected layers, and enable exhaustive handling of all error variants via discriminated unions.

---

## 8. Require exhaustive dispatch on discriminated types

Require all switch/if-else chains that dispatch on a discriminated union type to handle every variant exhaustively. Use a never-assignable default case (TypeScript) or exhaustive pattern matching (C#) to cause compile-time errors when new variants are added.

**BAD — TypeScript:**
```typescript
function dispatch(notification: Notification): void {
  if (notification.type === 'email') {
    sendEmail(notification);
  } else if (notification.type === 'sms') {
    sendSms(notification);
  }
  // 'push' type added last week — silently ignored
}
```

**BAD — C#:**
```csharp
public void Dispatch(Notification notification)
{
    switch (notification.Type)
    {
        case NotificationType.Email:
            SendEmail(notification);
            break;
        case NotificationType.Sms:
            SendSms(notification);
            break;
        // NotificationType.Push added last week — no compile error
    }
}
```

**GOOD — TypeScript:**
```typescript
function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

function dispatch(notification: Notification): void {
  switch (notification.type) {
    case 'email':
      sendEmail(notification);
      break;
    case 'sms':
      sendSms(notification);
      break;
    case 'push':
      sendPush(notification);
      break;
    default:
      assertNever(notification); // compile error if a variant is missing
  }
}
```

**GOOD — C#:**
```csharp
public void Dispatch(Notification notification)
{
    _ = notification.Type switch
    {
        NotificationType.Email => SendEmail(notification),
        NotificationType.Sms => SendSms(notification),
        NotificationType.Push => SendPush(notification),
        _ => throw new UnreachableException($"Unhandled: {notification.Type}")
    };
}
```

Non-exhaustive dispatch silently drops new variants, causing bugs that only surface at runtime. Exhaustive matching via `never` in TypeScript or switch expressions in C# turns missing handlers into compile-time errors, ensuring every new variant forces the developer to handle it everywhere it matters.

---

## 9. Reject shared mutable state between modules

Reject mutable static fields, singleton state bags, and global variables that are read and written by multiple modules. Use explicit dependency injection to share state, or event-driven patterns to propagate changes.

**BAD — TypeScript:**
```typescript
// shared/app-state.ts
export const appState = {
  currentUser: null as User | null,
  featureFlags: {} as Record<string, boolean>,
  requestCount: 0,
};

// modules/auth/login.ts
import { appState } from '../../shared/app-state.js';
export function login(user: User): void {
  appState.currentUser = user;
  appState.requestCount++;
}

// modules/billing/checkout.ts
import { appState } from '../../shared/app-state.js';
export function checkout(): void {
  if (!appState.currentUser) throw new Error('Not logged in');
  appState.requestCount++;
}
```

**BAD — C#:**
```csharp
public static class AppState
{
    public static User? CurrentUser { get; set; }
    public static Dictionary<string, bool> FeatureFlags { get; } = new();
    public static int RequestCount { get; set; }
}

// Modules/Auth/LoginService.cs
public void Login(User user)
{
    AppState.CurrentUser = user;
    AppState.RequestCount++;
}

// Modules/Billing/CheckoutService.cs
public void Checkout()
{
    if (AppState.CurrentUser is null) throw new InvalidOperationException();
    AppState.RequestCount++;
}
```

**GOOD — TypeScript:**
```typescript
// modules/auth/auth-context.ts
export interface IAuthContext {
  readonly currentUser: User | null;
}

// modules/billing/checkout-service.ts
export class CheckoutService {
  constructor(private readonly auth: IAuthContext) {}

  checkout(): void {
    if (!this.auth.currentUser) {
      throw new Error('Not logged in');
    }
  }
}
```

**GOOD — C#:**
```csharp
public interface IAuthContext
{
    User? CurrentUser { get; }
}

public sealed class CheckoutService
{
    private readonly IAuthContext _auth;

    public CheckoutService(IAuthContext auth) => _auth = auth;

    public void Checkout()
    {
        if (_auth.CurrentUser is null)
            throw new InvalidOperationException("Not logged in");
    }
}
```

Shared mutable state creates hidden coupling between modules. Any module can change state that another module reads, producing race conditions, unpredictable initialization order, and test contamination. Injected read-only interfaces make data flow explicit, testable, and free of temporal coupling.

---

## 10. Require configuration values from injected typed objects

Require service-layer code to receive configuration through typed, injected configuration objects. Reject direct `process.env` / `Environment.GetEnvironmentVariable` reads scattered throughout service code, and reject hardcoded magic strings for URLs, connection strings, timeouts, or feature flags.

**BAD — TypeScript:**
```typescript
// services/email-service.ts
export class EmailService {
  async send(to: string, body: string): Promise<void> {
    const apiKey = process.env.SENDGRID_API_KEY;      // env read buried in service
    const from = 'noreply@myapp.com';                 // hardcoded
    const timeout = 5000;                             // magic number

    await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to, from, body }),
      signal: AbortSignal.timeout(timeout),
    });
  }
}
```

**BAD — C#:**
```csharp
public sealed class EmailService
{
    public async Task SendAsync(string to, string body)
    {
        var apiKey = Environment.GetEnvironmentVariable("SENDGRID_API_KEY");
        var from = "noreply@myapp.com";
        var timeout = TimeSpan.FromSeconds(5);

        using var client = new HttpClient { Timeout = timeout };
        client.DefaultRequestHeaders.Authorization = new("Bearer", apiKey);
        await client.PostAsync("https://api.sendgrid.com/v3/mail/send",
            new StringContent(JsonSerializer.Serialize(new { to, from, body })));
    }
}
```

**GOOD — TypeScript:**
```typescript
// config/email-config.ts
export interface EmailConfig {
  readonly apiKey: string;
  readonly fromAddress: string;
  readonly timeoutMs: number;
  readonly endpoint: string;
}

// services/email-service.ts
export class EmailService {
  constructor(private readonly config: EmailConfig) {}

  async send(to: string, body: string): Promise<void> {
    await fetch(this.config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({ to, from: this.config.fromAddress, body }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
  }
}
```

**GOOD — C#:**
```csharp
public sealed record EmailOptions
{
    public required string ApiKey { get; init; }
    public required string FromAddress { get; init; }
    public required TimeSpan Timeout { get; init; }
    public required string Endpoint { get; init; }
}

public sealed class EmailService
{
    private readonly EmailOptions _options;

    public EmailService(IOptions<EmailOptions> options) => _options = options.Value;

    public async Task SendAsync(string to, string body)
    {
        using var client = new HttpClient { Timeout = _options.Timeout };
        client.DefaultRequestHeaders.Authorization = new("Bearer", _options.ApiKey);
        await client.PostAsync(_options.Endpoint,
            new StringContent(JsonSerializer.Serialize(new { to, from = _options.FromAddress, body })));
    }
}
```

Scattered `process.env` reads and hardcoded values make configuration impossible to validate at startup, difficult to override in tests, and invisible when auditing what a service depends on. A typed configuration object centralizes validation, enables compile-time checking of required values, and makes the service testable without manipulating environment variables.

---

## 11. Require cross-cutting concerns to use middleware or decorator patterns

Require logging, authentication, authorization, input validation, and request tracing to be applied through middleware, decorators, or interceptors — not duplicated inline in each handler or service method.

**BAD — TypeScript:**
```typescript
// routes/users.ts
app.get('/users/:id', async (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /users/${req.params.id}`);

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  if (!req.params.id.match(/^[a-z0-9-]+$/)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  const result = await userService.findById(req.params.id);
  console.log(`[${new Date().toISOString()}] Response: ${result ? 200 : 404}`);
  res.json(result);
});

// routes/orders.ts — same auth/logging/validation copy-pasted
app.get('/orders/:id', async (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /orders/${req.params.id}`);
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  // ... same pattern repeated
});
```

**BAD — C#:**
```csharp
[HttpGet("{id}")]
public async Task<IActionResult> Get(string id)
{
    _logger.LogInformation("GET /users/{Id}", id);

    if (!Request.Headers.TryGetValue("Authorization", out var authHeader))
        return Unauthorized();
    var user = _tokenService.Verify(authHeader.ToString().Replace("Bearer ", ""));
    if (user is null) return Unauthorized();

    if (!Regex.IsMatch(id, "^[a-z0-9-]+$"))
        return BadRequest("Invalid ID format");

    var result = await _userService.FindAsync(id);
    _logger.LogInformation("Response: {Status}", result is null ? 404 : 200);
    return result is null ? NotFound() : Ok(result);
}
```

**GOOD — TypeScript:**
```typescript
// middleware/auth.ts
export const requireAuth: Middleware = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing token' });
  req.user = verifyToken(token);
  if (!req.user) return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Invalid token' });
  next();
};

// routes/users.ts — clean, focused handler
app.get('/users/:id', requireAuth, validate(idParamSchema), async (req, res) => {
  const result = await userService.findById(req.params.id);
  res.json(result);
});
```

**GOOD — C#:**
```csharp
[Authorize]
[ApiController]
[Route("api/users")]
public sealed class UsersController : ControllerBase
{
    private readonly IUserService _userService;

    [HttpGet("{id:regex(^[[a-z0-9-]]+$)}")]
    public async Task<IActionResult> Get(string id)
    {
        var result = await _userService.FindAsync(id);
        return result is null ? NotFound() : Ok(result);
    }
}
// Logging handled globally via middleware pipeline in Program.cs
```

When cross-cutting concerns are copy-pasted into every handler, security gaps emerge from inconsistent application, logging formats drift, and updating the pattern requires finding and modifying every handler. Middleware/decorator patterns enforce consistency and make it impossible to accidentally skip a required concern.

---

## 12. Reject interfaces that expose implementation details in method signatures

Require interface method signatures to use domain types and abstractions, not implementation-specific types. Reject interfaces whose methods accept or return ORM entities, HTTP request/response objects, framework-specific types, or database connection objects.

**BAD — TypeScript:**
```typescript
// interfaces/user-repository.ts
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Request } from 'express';

export interface IUserRepository {
  findByRequest(req: Request): Promise<Prisma.UserGetPayload<{ include: { orders: true } }>>;
  executeQuery(client: PrismaClient, sql: string): Promise<unknown>;
  findWithPrismaArgs(args: Prisma.UserFindManyArgs): Promise<Prisma.UserGetPayload<{}>[]>;
}
```

**BAD — C#:**
```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Http;

public interface IUserRepository
{
    Task<User> FindByRequestAsync(HttpRequest request);
    Task<List<User>> QueryAsync(DbContext context, string sql);
    IQueryable<User> GetQueryable();
}
```

**GOOD — TypeScript:**
```typescript
import type { User, UserFilter, UserWithOrders } from '../domain/user.js';

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findMany(filter: UserFilter): Promise<readonly User[]>;
  findWithOrders(id: string): Promise<UserWithOrders | null>;
  save(user: User): Promise<void>;
}
```

**GOOD — C#:**
```csharp
public interface IUserRepository
{
    Task<User?> FindByIdAsync(string id);
    Task<IReadOnlyList<User>> FindManyAsync(UserFilter filter);
    Task<UserWithOrders?> FindWithOrdersAsync(string id);
    Task SaveAsync(User user);
}
```

Interfaces exist to decouple consumers from implementations. When an interface method signature contains Prisma types, EF DbContext, HttpRequest, or IQueryable, every consumer is effectively coupled to that specific framework. Swapping the ORM, HTTP framework, or database requires changing the interface and every consumer, defeating the purpose of the abstraction entirely.

---

## Summary

| # | Category | Rule | Key Signal |
|---|----------|------|------------|
| 1 | Dependency Direction | Require constructor injection | `new ServiceClass()` in method body |
| 2 | Module Boundaries | Import from public API only | Import path into `/internal/` or deep sibling paths |
| 3 | Module Boundaries | Reject circular dependencies | Module A imports B, B imports A |
| 4 | Layer Separation | No business logic in controllers | DB queries or branching logic in route handlers |
| 5 | Layer Separation | No data access from UI layer | ORM/repository imports in components or view models |
| 6 | API Contracts | Consistent error response shape | Different error structures across endpoints |
| 7 | Error Propagation | Typed Result for cross-module errors | `throw` for recoverable business failures at boundaries |
| 8 | Extensibility | Exhaustive dispatch on discriminated types | Switch without `never`/`UnreachableException` default |
| 9 | Shared State | No shared mutable globals | Exported mutable objects written by multiple modules |
| 10 | Configuration | Injected typed config objects | `process.env` / `GetEnvironmentVariable` in services |
| 11 | Cross-cutting | Consistent middleware/decorator patterns | Auth/logging/validation duplicated across handlers |
| 12 | Extensibility | No implementation details in interfaces | Framework types in interface signatures |
