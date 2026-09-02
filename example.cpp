// THsi is a comment
#include <cassert>
#include <iostream>
#include <limits>
#include <string>

#define TRY_LIMIT 4

int add(int x, int y);

int getValueFromUser() {
  int x = 0;
  std::cin >> x;
  return x;
}

int doubleInteger(int i) { return i * 2; }

#define bool int
#define true 1
#define false 0

struct Player {
  int x;
  int y[2];
  char z[2];
};

typedef enum {
  Operation_fail,
  Operation_mul,
  Operation_div,
  Operation_sub,
  Operation_add,
} Operation;

Operation getOpFromUser() {
  for (int i = 0; i <= TRY_LIMIT; ++i) {
    std::cout << "please enter a sign (*/-+): \n";
    char x;
    std::cin >> x;
    if (std::cin.fail()) {
      std::cin.clear();
      std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
      std::cout << "invalid input. " << TRY_LIMIT - i - 1
                << " attempts remaining. pleae try again \n";
      continue;
    }

    switch (x) {
    case '*': {
      return Operation_mul;
    } break;
    case '/': {
      return Operation_div;
    } break;
    case '-': {
      return Operation_sub;
    } break;
    case '+': {
      return Operation_add;
    } break;
    default: {
      std::cout << "invalid input. " << TRY_LIMIT - i - 1
                << " attempts remaining. pleae try again \n";
      continue;
    }
    }
  }

  return Operation_fail;
}

int getDoubleFromUser(double *x) {
  std::cout << "enter a double: \n";

  for (int i = 0; i < TRY_LIMIT; ++i) {
    std::cin >> *x;
    if (std::cin.fail()) {
      std::cin.clear();
      std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
      std::cout << "invalid input. " << TRY_LIMIT - i - 1
                << " attempts remaining. pleae try again \n";
      continue;
    }
    return 0;
  }
  return 1;
}

double calculateHeightAfterSeconds(double starting_height, double seconds) {
  return starting_height - (9.8 * (seconds * seconds) / 2);
}

#include <climits>

const int g_seed{0};

constexpr int generateRandomNumber() {
  return (8253729 * g_seed + 2396403) % 32768;
}

constexpr int wrap(int value, int min_val, int max_val) {
  int range = max_val - min_val;
  return min_val + (((value - min_val) % range) + range) % range;
}

constexpr int generateRandomNumberInRange(int min_val, int max_val) {
  return wrap(generateRandomNumber(), min_val, max_val);
}

#define MAX_GUESSES 10

constexpr int g_secret = generateRandomNumberInRange(0, 100);

void playHiLo() {
  std::cout << "Welcome to hi lo \n";
  std::cout << "don't tell anyone, but the secret is " << g_secret << "\n";

  int repeat_cnt = 4;
  int guess_cnt = 0;
  while (guess_cnt <= MAX_GUESSES) {

    int guess{};
    for (int i = 0; i < repeat_cnt; ++i) {

      if (i == 0) {
        std::cout << "Please guess a number in the range [0, 100]\n";
      } else {
        std::cout << "Pleaes guess again.\n";
      }

      std::cin >> guess;

      if (!std::cin) {
        if (i == repeat_cnt - 1) {
          std::cout << "max repeat count hit. thanks for playing.\n";
          std::exit(1);
        }
        if (std::cin.eof()) {
          std::exit(1);
        }

        std::cin.clear();
        std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');

        std::cout << "invalid input. pleae try again.\n";
        continue;
      }
    }

    if (guess < 0 || guess >= 100) {
      std::cout << "please guess in the range [0, 100].\n";
      continue;
    }

    if (guess > g_secret) {
      std::cout << "hi\n";
    } else if (guess < g_secret) {
      std::cout << "lo\n";
    } else {
      std::cout << "you guessed correctly!!\n";
      std::exit(0);
    }
    guess_cnt += 1;
  }
  std::cout << "you lose!!\n";
}

int main(void) {
  // char ch = 'A';
  // bool ok = 1;
  // double f = 3.14;
  // struct Player p = {99, {3, 4}, {'h', 'i'}};
  // int ints[4] = {1, 2, 3, 4};
  // char msg[16] = "hello";
  // const char *s = "world";
  // ch = 'b';
  // ok = false;
  // f = 2.16;
  // p = {};
  // ints[0] = 0;
  // msg[0] = 'H';
  //
  // std::cout << s << ch << ok << f << p.x << ints[0] << msg[0] << '\n';
  // // //    int lets_do;
  // //     lets_do = 10;
  // //     float f = 10.0;s;
  // //     printf("float %f, lets_do %d", f, lets_do);
  // //
  // //     int total = 0;
  // //     for (int i = 0; i < 10; i++)
  // //     {
  // //         total += i;
  // //     }
  // //     return 0;
  //
  // // get input
  // // double input
  // // check diff between ++x x++ and x += 1
  // int input = getValueFromUser();
  // int doubledInput = doubleInteger(input);
  // std::cout << "Doubled input: " << doubledInput << "\n";
  //
  // int b = ++input;
  // int c = input++;
  // int d = input += 1;
  // int e = add(input, 100);
  //
  // std::cout << b << "\n";
  // std::cout << c << "\n";
  // std::cout << d << "\n";
  // std::cout << e << "\n";

  // char c1 { };
  // std::cout << "input a character \n";
  // std::cin >> c1;
  // std::cout << "your input as a number: " << static_cast<int>(c1) << "\n";

  // double x1{};
  // double x2{};
  // int err{};
  // err = getDoubleFromUser(&x1);
  // if (err) {
  //   std::cout << "failed to enter a double \n";
  //   return EXIT_FAILURE;
  // }
  // err = getDoubleFromUser(&x2);
  // if (err) {
  //   std::cout << "failed to enter a double \n";
  //   return EXIT_FAILURE;
  // }
  //
  // Operation operation = getOpFromUser();
  // switch (operation) {
  // case Operation_mul: {
  //   std::cout << x1 << " * " << x2 << " = " << x1 * x2 << '\n';
  // } break;
  // case Operation_div: {
  //   std::cout << x1 << " / " << x2 << " = " << x1 / x2 << '\n';
  // } break;
  // case Operation_add: {
  //   std::cout << x1 << " + " << x2 << " + " << x1 / x2 << '\n';
  // } break;
  // case Operation_sub: {
  //   std::cout << x1 << " - " << x2 << " - " << x1 / x2 << '\n';
  //   break;
  // }
  // case Operation_fail:
  // default: {
  //   std::cout << "invalid operation.\n";
  // }
  // }

  // std::cout << "Enter the height of the tower in meters: \n";
  //
  // double starting_height_meters{};
  // int err = getDoubleFromUser(&starting_height_meters);
  // if (err) {
  //   std::cout << "failed to get height of tower in meters: \n";
  //   return EXIT_FAILURE;
  // }
  //
  // double step_size = 0.01;
  // for (double seconds = 0;; seconds += step_size) {
  //   double current_height_meters =
  //       calculateHeightAfterSeconds(starting_height_meters, seconds);
  //
  //   if (current_height_meters < 0) {
  //     std::cout << "The ball hit the ground\n";
  //     return EXIT_SUCCESS;
  //   }
  //
  //   std::cout << "After " << seconds
  //             << " seconds, the balls hieght is: " << current_height_meters
  //             << "\n";
  // }

  // std::string name{};
  // int age{};
  // int name_len{};
  //
  // std::cout << " Pleae enter your name: ";
  // std::getline(std::cin >> std::ws, name);
  // name_len = static_cast<int>(name.length());
  //
  // std::cout << " Pleae enter your age: ";
  // std::cin >> age;
  //
  // std::cout << " The length of your name is: " << name.length() << "\n";
  // std::cout << " Yout age is: " << age << "\n";
  // std::cout << " Yout name legth + age is : " << age + name_len << "\n";
  //
  // std::string_view sv{name};
  // std::cout << " a view to your string " << sv << "\n";
  //
  // name.clear();
  // std::string(name).swap(name);
  // std::string other(100, 'X');
  // std::cout << " a freed the string, what happens when we view " << sv <<
  // "\n";

  // for (char c = 'A'; c <= 'z'; c++) {
  //   std::cout << c << ": " << static_cast<int>(c) << "\n";
  // }

  // int x{};
  // std::cin >> x;
  // if (!std::cin) {
  //   if (std::cin.eof()) {
  //     std::cout << "eof\n";
  //   }
  // }
  // for (int i = 5; i > 0; i--) {
  //   for (int j = i; j > 0; j--) {
  //     std::cout << j << " ";
  //   }
  //   std::cout << "\n";
  // }

  // playHiLo();
  int x{1};
  const int &y = x;
  add(1, 2);

  std::cout << y;
  return EXIT_SUCCESS;
}
