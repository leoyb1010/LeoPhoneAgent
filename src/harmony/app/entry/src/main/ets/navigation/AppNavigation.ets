import { ShareMessage } from '../chat/TurnShare';

/** One native destination stack, owned by HomePage for the lifetime of the window. */
export class RouteParams {
  scanId?: string;
  title?: string;
  text?: string;
  path?: string;
  directory?: boolean;
  messages?: ShareMessage[];
}
export class NavigationState {
  name: string = 'HomePage';
  path: string = 'pages/HomePage';
  index: number = -1;
}
export class PageRequest {
  url: string = '';
  params?: RouteParams;
}
export class AppNavigation {
  static stack: NavPathStack = new NavPathStack();
  static ready: boolean = false;
  static async pushUrl(request: PageRequest): Promise<void> {
    if (!AppNavigation.ready) throw new Error('导航尚未就绪，请回到首页后重试');
    AppStorage.setOrCreate('inspectorVisible', false);
    AppNavigation.stack.pushPathByName(request.url, request.params ?? new RouteParams());
    AppNavigation.changed();
  }
  static async replaceUrl(request: PageRequest): Promise<void> {
    if (!AppNavigation.ready) throw new Error('导航尚未就绪');
    AppNavigation.stack.replacePathByName(request.url, request.params ?? new RouteParams());
    AppNavigation.changed();
  }
  static back(): void { AppNavigation.stack.pop(); AppNavigation.changed(); }
  static getParams(): RouteParams {
    const params = AppNavigation.stack.getParamByIndex(AppNavigation.stack.size() - 1) as RouteParams;
    return params ?? new RouteParams();
  }
  static getState(): NavigationState {
    const state = new NavigationState();
    const names = AppNavigation.stack.getAllPathName();
    state.index = names.length - 1;
    if (state.index >= 0) {
      state.path = names[state.index];
      state.name = state.path.substring(state.path.lastIndexOf('/') + 1);
    }
    return state;
  }
  static changed(): void { AppStorage.setOrCreate('navigationTick', (AppStorage.get<number>('navigationTick') ?? 0) + 1); }
}
