import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { DEV_USERS, getDevUser, setDevUser } from './dev-user';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly users = DEV_USERS;
  protected readonly currentUser = getDevUser();

  protected switchUser(name: string): void {
    setDevUser(name);
    location.reload();
  }
}
